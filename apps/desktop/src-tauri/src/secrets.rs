//! Secrets an agent asks the user for (#1578): `dray secret request` puts a
//! masked card in the chat, and the value the user saves goes to an
//! owner-only file on this machine, never to the transcript, the log, the
//! index or the model. The agent is told the file's path in a hidden prompt
//! and reads it inside its own command, so the harness's sandbox and
//! approvals still apply. That keeps a secret out of chat; it does not hide
//! it from the agent, which can read the file, and the card says so.
//!
//! One-time by default: `once/` files are swept a day after they are written.
//! "Save as NAME" writes `saved/NAME` instead, which any task here can find
//! through `dray secret request NAME`, handed over in one click or, where
//! the user lets agents use it without asking, at once; Settings lists them by name.
//!
//! An open card is kept in `pending.json` beside them (what was asked, never
//! a value), so it still answers after a restart and every client is told of
//! it on connect.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use anyhow::{bail, Context, Result};
use dray_proto::{CancelSecret, RequestSecret, Response, SecretSummary};
use serde::{Deserialize, Serialize};

use crate::events::{AgentEvent, AgentEventPayload, SecretOutcome};
use crate::{session::manager, sink::Sink, store, Fail};

/// How long a one-time secret's file lives.
const ONCE_FOR: Duration = Duration::from_secs(24 * 60 * 60);

/// A value shorter than this is not masked in transcripts: a short password
/// matching ordinary text would blank words out of the conversation.
const MASK_MIN: usize = 6;

const MAX_VALUE: usize = 64 * 1024;

/// Emitted when the saved list changes, so Settings re-reads it.
pub const SECRETS_CHANGED: &str = "secrets_changed";

/// Held over every read-modify-write of `pending.json` and the answer that
/// closes a card, so a double click cannot save twice.
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The open cards as logged, for `live_state`. Loaded by [`start`].
static OPEN: Mutex<Vec<AgentEvent>> = Mutex::new(Vec::new());

/// Every value saved here this run or found on disk at start, for [`mask`].
static MASKS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// An env-var-like name: it becomes a file name and the agent's variable.
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.len() <= 64
}

fn check_name(name: &str) -> Result<()> {
    if !valid_name(name) {
        bail!("name the secret like an environment variable, such as GITHUB_TOKEN: letters, digits and _, not \"{name}\"");
    }
    Ok(())
}

/// A link on a card must be http(s): the card opens it in the system browser.
fn check_url(url: Option<&str>) -> Result<()> {
    if url.is_some_and(|u| !u.starts_with("https://") && !u.starts_with("http://")) {
        bail!("--url takes an http or https link");
    }
    Ok(())
}

/// `<home>/secrets/<sub>`, each level `0700`.
async fn dir(sub: Option<&str>) -> Result<PathBuf> {
    let root = store::app_subdir("secrets").await?;
    store::restrict_to_owner(&root).await;
    let Some(sub) = sub else { return Ok(root) };
    let path = root.join(sub);
    tokio::fs::create_dir_all(&path).await?;
    store::restrict_to_owner(&path).await;
    Ok(path)
}

/// Writes `value` to `path` as a `0600` file: a fresh temp beside it, created
/// with that mode rather than chmodded after, then renamed over.
async fn write_private(path: PathBuf, value: String) -> Result<()> {
    tokio::task::spawn_blocking(move || -> Result<()> {
        use std::io::Write;
        let temp = path.with_file_name(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let mut open = std::fs::OpenOptions::new();
        open.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
        let mut file = open.open(&temp).with_context(|| format!("could not create {}", temp.display()))?;
        let written = file.write_all(value.as_bytes()).and_then(|()| file.sync_all());
        drop(file);
        if let Err(e) = written.map_err(anyhow::Error::from).and_then(|()| Ok(std::fs::rename(&temp, &path)?)) {
            let _ = std::fs::remove_file(&temp);
            return Err(e.context(format!("could not write {}", path.display())));
        }
        Ok(())
    })
    .await?
}

fn remember(value: &str) {
    if value.len() < MASK_MIN {
        return;
    }
    let mut masks = MASKS.lock().unwrap();
    if !masks.iter().any(|m| m == value) {
        masks.push(value.to_string());
    }
}

/// `text` with every known secret value blanked. Best effort: a value split
/// across deltas, encoded or reformatted gets through, which is why nothing
/// here relies on it.
pub fn mask_text(text: &str) -> Option<String> {
    let masks = MASKS.lock().unwrap();
    let mut out: Option<String> = None;
    for value in masks.iter() {
        // The JSON-escaped form too, since a log line holds the value that way.
        let escaped = serde_json::to_string(value).ok().map(|s| s[1..s.len() - 1].to_string());
        for needle in std::iter::once(value.as_str()).chain(escaped.as_deref()) {
            let current = out.as_deref().unwrap_or(text);
            if current.contains(needle) {
                out = Some(current.replace(needle, "••••••••"));
            }
        }
    }
    out
}

/// [`mask_text`] over a whole event, cheap when nothing is saved.
pub fn mask(event: &mut AgentEvent) {
    if MASKS.lock().unwrap().is_empty() {
        return;
    }
    let Ok(json) = serde_json::to_string(&event.payload) else { return };
    if let Some(masked) = mask_text(&json) {
        if let Ok(payload) = serde_json::from_str(&masked) {
            event.payload = payload;
        }
    }
}

/// Loads the open cards and the values to mask, sweeps expired one-time
/// files, and keeps sweeping hourly.
pub async fn start() {
    if let Ok(open) = read_pending().await {
        *OPEN.lock().unwrap() = open;
    }
    for sub in ["saved", "once"] {
        let Ok(dir) = dir(Some(sub)).await else { continue };
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else { continue };
        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Ok(value) = tokio::fs::read_to_string(entry.path()).await {
                remember(&value);
            }
        }
    }
    tokio::spawn(async {
        loop {
            sweep().await;
            tokio::time::sleep(Duration::from_secs(60 * 60)).await;
        }
    });
}

/// Deletes one-time files older than [`ONCE_FOR`].
async fn sweep() {
    let Ok(dir) = dir(Some("once")).await else { return };
    let Ok(mut entries) = tokio::fs::read_dir(&dir).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let old = entry
            .metadata()
            .await
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age >= ONCE_FOR);
        if old {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

async fn pending_path() -> Result<PathBuf> {
    Ok(dir(None).await?.join("pending.json"))
}

async fn read_pending() -> Result<Vec<AgentEvent>> {
    match tokio::fs::read(pending_path().await?).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

async fn write_pending(open: Vec<AgentEvent>) -> Result<()> {
    write_private(pending_path().await?, serde_json::to_string(&open)?).await?;
    *OPEN.lock().unwrap() = open;
    Ok(())
}

/// Saved names agents get without a card, in `always.json`: names alone.
async fn read_always() -> Vec<String> {
    let Ok(path) = dir(None).await.map(|d| d.join("always.json")) else { return Vec::new() };
    tokio::fs::read(path).await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

async fn set_always(name: &str, on: bool) -> Result<()> {
    let mut names = read_always().await;
    names.retain(|n| n != name);
    if on {
        names.push(name.to_string());
        names.sort();
    }
    write_private(dir(None).await?.join("always.json"), serde_json::to_string(&names)?).await
}

async fn saved_path(name: &str) -> Result<Option<PathBuf>> {
    let path = dir(Some("saved")).await?.join(name);
    Ok(tokio::fs::try_exists(&path).await.unwrap_or(false).then_some(path))
}

/// The names saved here.
async fn saved_names() -> Vec<String> {
    saved().await.map(|list| list.into_iter().map(|s| s.name).collect()).unwrap_or_default()
}

/// Words that say what kind of secret, never whose: two names sharing only
/// these are not the same secret.
const KIND_WORDS: [&str; 8] = ["TOKEN", "KEY", "API", "SECRET", "PAT", "PASSWORD", "ACCESS", "AUTH"];

/// The saved name nearest `name` by its words, with GH read as GITHUB and so
/// on: they must share a word that is not a kind word, and half their words.
fn closest_name(name: &str, saved: &[String]) -> Option<String> {
    if saved.iter().any(|s| s == name) {
        return Some(name.to_string());
    }
    let words = |n: &str| -> std::collections::BTreeSet<String> {
        n.split('_')
            .filter(|w| !w.is_empty())
            .map(|w| match w.to_ascii_uppercase().as_str() {
                "GH" => "GITHUB".to_string(),
                "GL" => "GITLAB".to_string(),
                "CF" => "CLOUDFLARE".to_string(),
                "PASS" | "PW" | "PWD" => "PASSWORD".to_string(),
                other => other.to_string(),
            })
            .collect()
    };
    let asked = words(name);
    saved
        .iter()
        .filter_map(|s| {
            let theirs = words(s);
            let shared: Vec<&String> = asked.intersection(&theirs).collect();
            if !shared.iter().any(|w| !KIND_WORDS.contains(&w.as_str())) {
                return None;
            }
            let score = shared.len() as f32 / asked.union(&theirs).count() as f32;
            (score >= 0.5).then_some((score, s))
        })
        .max_by(|a, b| a.0.total_cmp(&b.0).then_with(|| b.1.len().cmp(&a.1.len())))
        .map(|(_, s)| s.clone())
}

/// Which saved secret a request for one name was answered with before, by
/// name: `aliases.json`, names alone.
async fn read_aliases() -> std::collections::BTreeMap<String, String> {
    let Ok(path) = dir(None).await.map(|d| d.join("aliases.json")) else { return Default::default() };
    tokio::fs::read(path).await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

async fn set_alias(name: &str, to: Option<&str>) -> Result<()> {
    let mut aliases = read_aliases().await;
    match to {
        Some(to) if to != name => aliases.insert(name.to_string(), to.to_string()),
        _ => aliases.remove(name),
    };
    write_private(dir(None).await?.join("aliases.json"), serde_json::to_string(&aliases)?).await
}

/// The saved secret a request for `name` answers with: itself where saved,
/// else the one picked for it before, while that is still saved.
async fn resolve(name: &str, saved: &[String]) -> Option<String> {
    if saved.iter().any(|s| s == name) {
        return Some(name.to_string());
    }
    read_aliases().await.remove(name).filter(|to| saved.contains(to))
}

/// Drops a settled or deleted session's open cards: nobody waits on them.
pub async fn forget(session_id: &str) {
    let _held = LOCK.lock().await;
    let Ok(mut open) = read_pending().await else { return };
    let before = open.len();
    open.retain(|e| e.session_id != session_id);
    if open.len() != before {
        if let Err(e) = write_pending(open).await {
            eprintln!("[secrets] could not drop {session_id}'s cards: {e:#}");
        }
    }
}

/// The open cards, as `live_state` sends them. A task's ask of its bot on
/// another machine is not one: that machine draws its card.
pub fn open_cards() -> Vec<AgentEvent> {
    OPEN.lock().unwrap().iter().filter(|e| !asks_bot(e)).cloned().collect()
}

fn asks_bot(event: &AgentEvent) -> bool {
    matches!(event.payload, AgentEventPayload::SecretRequested { bot: true, .. })
}

/// The sessions behind an open card.
pub fn asking() -> impl Iterator<Item = String> {
    open_cards().into_iter().map(|e| e.session_id)
}

/// A card closed by Dray or the agent rather than answered: nothing kept.
fn closed(request_id: &str, name: &str, outcome: SecretOutcome, task: Option<crate::events::SecretTask>) -> AgentEventPayload {
    AgentEventPayload::SecretAnswered {
        request_id: request_id.to_string(),
        name: name.to_string(),
        outcome,
        kept: false,
        always: false,
        auto: false,
        task,
        from: None,
    }
}

fn card_of(event: &AgentEvent) -> Option<(&str, &str)> {
    match &event.payload {
        AgentEventPayload::SecretRequested { request_id, name, .. } => Some((request_id, name)),
        _ => None,
    }
}

/// `dray secret request`: posts the card in the calling chat and answers at
/// once. An open card for the same name there is closed as replaced, so a
/// retry never leaves two.
pub async fn request(ask: RequestSecret, app: &Sink) -> Result<Response> {
    let name = ask.name.trim().to_string();
    check_name(&name)?;
    let reason = ask.reason.trim().to_string();
    if reason.is_empty() {
        bail!("say why with --reason: the user reads it before pasting anything");
    }
    let tidy = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let url = tidy(ask.url);
    check_url(url.as_deref())?;
    let chat = store::get_session_index_item(&ask.session_id)
        .await?
        .with_context(|| format!("no session {}", ask.session_id))?;
    let label = tidy(ask.label);
    if bot_root(&chat).await.is_some() {
        return ask_bot(chat, name, label, reason, url, app).await;
    }

    let _held = LOCK.lock().await;
    let names = saved_names().await;
    let resolved = resolve(&name, &names).await;
    let auto = match &resolved {
        Some(r) if read_always().await.contains(r) => saved_path(r).await?,
        _ => None,
    };
    if let Some(path) = &auto {
        // Used without asking: no card, and the path goes back in the tool's own answer.
        let payload = AgentEventPayload::SecretAnswered {
            request_id: uuid::Uuid::new_v4().to_string(),
            name: name.clone(),
            outcome: SecretOutcome::Used,
            kept: true,
            always: true,
            auto: true,
            task: None,
            from: resolved.clone().filter(|r| *r != name),
        };
        manager().log_event(&chat.session_id, chat.harness, payload, app).await?;
        let path = path.display().to_string();
        return Ok(Response::SecretRequested { request_id: String::new(), name, replaced: false, path: Some(path), bot: false });
    }
    let mut open = read_pending().await?;
    let mut replaced = false;
    for old in open.iter().filter(|e| e.session_id == chat.session_id) {
        if let Some((request_id, old_name)) = card_of(old) {
            if old_name == name {
                let payload = closed(request_id, &name, SecretOutcome::Replaced, None);
                manager().log_event(&chat.session_id, chat.harness, payload, app).await?;
                replaced = true;
            }
        }
    }
    open.retain(|e| !(e.session_id == chat.session_id && card_of(e).is_some_and(|(_, n)| n == name)));
    let request_id = uuid::Uuid::new_v4().to_string();
    let payload = AgentEventPayload::SecretRequested {
        request_id: request_id.clone(),
        name: name.clone(),
        label,
        reason,
        url,
        saved: names.contains(&name),
        closest: resolved.or_else(|| closest_name(&name, &names)),
        saved_names: names,
        bot: false,
        task: None,
    };
    let event = manager().log_event(&chat.session_id, chat.harness, payload, app).await?;
    open.push(event);
    write_pending(open).await?;
    Ok(Response::SecretRequested { request_id, name, replaced, path: None, bot: false })
}

/// `dray secret cancel`: the agent takes back its own open card for `name`,
/// and is sent no answer. A card relayed into a bot's chat from a task is that
/// task's, never the bot's to take back.
pub async fn cancel(cancel: CancelSecret, app: &Sink) -> Result<Response> {
    let name = cancel.name.trim().to_string();
    check_name(&name)?;
    let chat = store::get_session_index_item(&cancel.session_id)
        .await?
        .with_context(|| format!("no session {}", cancel.session_id))?;
    let _held = LOCK.lock().await;
    let mut open = read_pending().await?;
    let Some(at) = open.iter().position(|e| own_card(e, &chat.session_id, &name)) else {
        return Ok(Response::SecretCancelled { name, withdrawn: false });
    };
    let request_id = card_of(&open[at]).map(|(id, _)| id.to_string()).unwrap_or_default();
    let payload = closed(&request_id, &name, SecretOutcome::Withdrawn, None);
    manager().log_event(&chat.session_id, chat.harness, payload, app).await?;
    open.remove(at);
    write_pending(open).await?;
    Ok(Response::SecretCancelled { name, withdrawn: true })
}

/// `session_id`'s own open card for `name`: never a card relayed into it.
fn own_card(event: &AgentEvent, session_id: &str, name: &str) -> bool {
    event.session_id == session_id
        && matches!(&event.payload, AgentEventPayload::SecretRequested { name: n, task: None, .. } if n == name)
}

/// A card relayed from a task on `machine_id` whose ask that machine no longer lists.
fn relay_withdrawn(event: &AgentEvent, machine_id: &str, asks: &[BotAsk]) -> bool {
    matches!(&event.payload, AgentEventPayload::SecretRequested { task: Some(t), .. }
        if t.machine_id == machine_id && !asks.iter().any(|a| a.request_id == t.request_id))
}

/// What the agent is told once the user saved it. Hidden, like an issue
/// hand-off.
fn saved_prompt(name: &str, path: &Path, kept: bool, always: bool) -> String {
    let path = path.display();
    let life = match (kept, always) {
        (true, true) => format!(
            "It is saved on this machine as {name} and agents may use it without asking: a later `dray secret request {name}` answers with its path at once, no card."
        ),
        (true, false) => format!("It is saved on this machine as {name}: a later `dray secret request {name}` lets the user hand it over in one click."),
        _ => "It is one-time: the file is deleted after 24 hours.".to_string(),
    };
    format!(
        "The user gave you {name} through Dray's secret card. Its value is in the file {path}, readable only by this user. {life} \
         Use it inside the command that needs it: redirect the file into a command that reads it on stdin (<command> < {path}), pass it to a flag that takes a file, \
         or set it for that one command, like {name}=\"$(cat {path})\" <command>. A login command that stores the credential wants stdin: a variable set beside it can stop it storing anything. \
         Never print, echo or log the value, never copy it into another file, a commit or a message, and never ask the user for it in chat. \
         Carry on with what you needed it for."
    )
}

fn declined_prompt(name: &str) -> String {
    format!(
        "The user declined the secret card for {name}. Don't ask for it in chat. Carry on without it, or say what you can't do without it and stop."
    )
}

/// The reader answered a secret card: `value` saved (kept under its name with
/// `keep`), or `None` to decline. The agent is told in a hidden prompt, then
/// the card is closed in the log. The value goes to the file alone.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn answer_secret_request(
    session_id: String,
    request_id: String,
    value: Option<String>,
    keep: bool,
    use_saved: Option<bool>,
    always: Option<bool>,
    from: Option<String>,
    sink: Sink,
) -> Result<(), Fail> {
    let use_saved = use_saved.unwrap_or(false);
    if let Some(from) = &from {
        check_name(from)?;
    }
    let always = always.unwrap_or(false);
    // Using it without asking only makes sense for a secret that stays.
    let keep = keep || always;
    let _held = LOCK.lock().await;
    let mut open = read_pending().await?;
    let at = open
        .iter()
        .position(|e| e.session_id == session_id && card_of(e).is_some_and(|(id, _)| id == request_id))
        .context("this card is already closed")?;
    let name = card_of(&open[at]).map(|(_, n)| n.to_string()).unwrap_or_default();
    #[cfg(any(feature = "serve", feature = "desktop"))]
    if let AgentEventPayload::SecretRequested { task: Some(task), .. } = &open[at].payload {
        let task = task.clone();
        let answer = Relayed { value, keep, use_saved, always, from };
        answer_relayed(&session_id, &request_id, &name, task, answer, &sink).await?;
        open.remove(at);
        write_pending(open).await?;
        return Ok(());
    }
    let item = store::get_session_index_item(&session_id).await?.context("no such session")?;
    if crate::bots::current_chat(item.clone()).await.archived {
        open.remove(at);
        write_pending(open).await?;
        return Err(anyhow::anyhow!("this chat is settled, so nobody is waiting on it").into());
    }

    let (prompt, written, outcome) = match value {
        _ if use_saved => {
            let from = from.clone().unwrap_or_else(|| name.clone());
            let path = saved_path(&from).await?.with_context(|| format!("{from} is no longer saved here; paste it instead"))?;
            set_alias(&name, Some(&from)).await?;
            (saved_prompt(&name, &path, true, always), None, SecretOutcome::Used)
        }
        Some(value) => {
            let value = value.trim().to_string();
            if value.is_empty() {
                return Err(anyhow::anyhow!("paste the value first").into());
            }
            if value.len() > MAX_VALUE {
                return Err(anyhow::anyhow!("that is longer than a secret should be").into());
            }
            let path = if keep {
                dir(Some("saved")).await?.join(&name)
            } else {
                dir(Some("once")).await?.join(format!("{name}-{}", uuid::Uuid::new_v4().simple()))
            };
            write_private(path.clone(), value.clone()).await?;
            remember(&value);
            (saved_prompt(&name, &path, keep, always), Some(path), SecretOutcome::Saved)
        }
        None => (declined_prompt(&name), None, SecretOutcome::Declined),
    };
    // Told before the card closes, so a send that fails leaves it open to retry.
    if let Err(e) = crate::orchestration::send_review(session_id.clone(), prompt, sink.clone()).await {
        if let (Some(path), false) = (written, keep) {
            let _ = tokio::fs::remove_file(path).await;
        }
        return Err(e.into());
    }
    let kept = (keep && outcome == SecretOutcome::Saved) || outcome == SecretOutcome::Used;
    let always = always && kept;
    // The saved secret it was answered with, which the switch belongs to.
    let used = if outcome == SecretOutcome::Used { from.clone().unwrap_or_else(|| name.clone()) } else { name.clone() };
    if always {
        set_always(&used, true).await?;
    }
    let from = (used != name).then_some(used);
    let payload = AgentEventPayload::SecretAnswered { request_id, name, outcome, kept, always, auto: false, task: None, from };
    manager().log_event(&session_id, item.harness, payload, &sink).await?;
    open.remove(at);
    write_pending(open).await?;
    if kept {
        sink.emit(SECRETS_CHANGED, ()).ok();
    }
    Ok(())
}

/// The saved secrets here, by name, never a value.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_secrets() -> Result<Vec<SecretSummary>, Fail> {
    Ok(saved().await?)
}

async fn saved() -> Result<Vec<SecretSummary>> {
    let dir = dir(Some("saved")).await?;
    let always = read_always().await;
    let mut entries = tokio::fs::read_dir(&dir).await?;
    let mut out = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_name(&name) {
            continue;
        }
        let modified = entry
            .metadata()
            .await
            .and_then(|m| m.modified())
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
            .unwrap_or_default();
        let always = always.contains(&name);
        out.push(SecretSummary { name, modified, always });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Settings' add and replace.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn save_secret(name: String, value: String, sink: Sink) -> Result<(), Fail> {
    let name = name.trim().to_string();
    check_name(&name)?;
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(anyhow::anyhow!("paste the value first").into());
    }
    if value.len() > MAX_VALUE {
        return Err(anyhow::anyhow!("that is longer than a secret should be").into());
    }
    write_private(dir(Some("saved")).await?.join(&name), value.clone()).await?;
    remember(&value);
    sink.emit(SECRETS_CHANGED, ()).ok();
    Ok(())
}

/// Settings' "Let agents use it without asking" switch on a saved secret.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_secret_always(name: String, on: bool, sink: Sink) -> Result<(), Fail> {
    check_name(&name)?;
    if on && saved_path(&name).await?.is_none() {
        return Err(anyhow::anyhow!("{name} is not saved here").into());
    }
    set_always(&name, on).await?;
    sink.emit(SECRETS_CHANGED, ()).ok();
    Ok(())
}

/// Settings' Delete: the saved file, its Auto mark and any alias naming it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_secret(name: String, sink: Sink) -> Result<(), Fail> {
    check_name(&name)?;
    set_always(&name, false).await?;
    let mut aliases = read_aliases().await;
    let before = aliases.len();
    aliases.retain(|_, to| *to != name);
    if aliases.len() != before {
        let json = serde_json::to_string(&aliases).map_err(anyhow::Error::from)?;
        write_private(dir(None).await?.join("aliases.json"), json).await?;
    }
    match tokio::fs::remove_file(dir(Some("saved")).await?.join(&name)).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(anyhow::Error::from(e).into()),
    }
    sink.emit(SECRETS_CHANGED, ()).ok();
    Ok(())
}

/// `dray secret path NAME`: answers only for a name agents may use without asking,
/// since a saved secret is otherwise the user's to hand over each time.
pub async fn path_of(name: &str) -> Result<Response> {
    check_name(name)?;
    let Some(path) = saved_path(name).await? else {
        bail!("no secret saved here as {name}. Ask the user for it with `dray secret request {name} --reason \"…\"`, never in chat.");
    };
    if !read_always().await.iter().any(|n| n == name) {
        bail!(
            "{name} is saved here, but the user hands it over each time. Ask with `dray secret request {name} --reason \"…\"`: they give it in one click."
        );
    }
    Ok(Response::SecretPath { name: name.to_string(), path: path.display().to_string() })
}

/// `dray secret ls`.
pub async fn list() -> Result<Response> {
    Ok(Response::Secrets { secrets: saved().await? })
}


/// The bot chat's session on another machine this task reports to, through
/// itself or a task above it here: whose machine keeps the secrets it uses.
async fn bot_root(item: &crate::store::SessionIndexItem) -> Option<String> {
    let mut at = item.clone();
    for _ in 0..16 {
        if crate::remote_reports::owed(&at.session_id).await {
            return Some(at.session_id);
        }
        let parent = at.parent_session_id.clone()?;
        at = store::get_session_index_item(&parent).await.ok().flatten()?;
    }
    None
}

/// A bot's task on another machine asking: no card here. The ask waits in
/// `pending.json` for the bot's server, which collects it with the task's
/// reports, draws the card in the bot's chat and sends the answer back.
async fn ask_bot(
    chat: crate::store::SessionIndexItem,
    name: String,
    label: Option<String>,
    reason: String,
    url: Option<String>,
    app: &Sink,
) -> Result<Response> {
    let _held = LOCK.lock().await;
    let mut open = read_pending().await?;
    let mut replaced = false;
    for old in open.iter().filter(|e| e.session_id == chat.session_id) {
        if let Some((request_id, old_name)) = card_of(old) {
            if old_name == name {
                let payload = closed(request_id, &name, SecretOutcome::Replaced, None);
                manager().log_event(&chat.session_id, chat.harness, payload, app).await?;
                replaced = true;
            }
        }
    }
    open.retain(|e| !(e.session_id == chat.session_id && card_of(e).is_some_and(|(_, n)| n == name)));
    let request_id = uuid::Uuid::new_v4().to_string();
    let payload = AgentEventPayload::SecretRequested {
        request_id: request_id.clone(),
        name: name.clone(),
        label,
        reason,
        url,
        saved: false,
        saved_names: Vec::new(),
        closest: None,
        bot: true,
        task: None,
    };
    let event = manager().log_event(&chat.session_id, chat.harness, payload, app).await?;
    open.push(event);
    write_pending(open).await?;
    Ok(Response::SecretRequested { request_id, name, replaced, path: None, bot: true })
}

/// A task's ask of its bot, as the bot's server collects it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotAsk {
    pub request_id: String,
    /// The task that asked.
    pub session_id: String,
    /// The task the bot's server tracks it under: it, or one above it.
    pub child: String,
    pub title: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// The open asks under `children`, for `parent_reports`.
pub async fn asks_for(children: &[String]) -> Vec<BotAsk> {
    let mut out = Vec::new();
    let cards: Vec<AgentEvent> = OPEN.lock().unwrap().clone();
    for event in cards.into_iter().filter(asks_bot) {
        let AgentEventPayload::SecretRequested { request_id, name, label, reason, url, .. } = event.payload else { continue };
        let Ok(Some(item)) = store::get_session_index_item(&event.session_id).await else { continue };
        let Some(child) = bot_root(&item).await.filter(|c| children.contains(c)) else { continue };
        out.push(BotAsk { request_id, session_id: event.session_id, child, title: item.title, name, label, reason, url });
    }
    out
}

/// The bot's server answering a task's ask here: `value` becomes a one-time
/// file on this machine and the task is told its path, or with `None` that
/// the user declined. An ask already closed answers Ok, so a retry is safe.
pub async fn deliver(session_id: String, request_id: String, value: Option<String>, sink: Sink) -> Result<(), Fail> {
    let _held = LOCK.lock().await;
    let mut open = read_pending().await?;
    let Some(at) = open
        .iter()
        .position(|e| e.session_id == session_id && asks_bot(e) && card_of(e).is_some_and(|(id, _)| id == request_id))
    else {
        return Ok(());
    };
    let name = card_of(&open[at]).map(|(_, n)| n.to_string()).unwrap_or_default();
    let item = store::get_session_index_item(&session_id).await?.context("no such session")?;
    let (prompt, written, outcome) = match value {
        Some(value) => {
            let value = value.trim().to_string();
            if value.is_empty() || value.len() > MAX_VALUE {
                return Err(anyhow::anyhow!("not a value this machine takes").into());
            }
            let path = dir(Some("once")).await?.join(format!("{name}-{}", uuid::Uuid::new_v4().simple()));
            write_private(path.clone(), value.clone()).await?;
            remember(&value);
            (bot_prompt(&name, &path), Some(path), SecretOutcome::Saved)
        }
        None => (declined_prompt(&name), None, SecretOutcome::Declined),
    };
    if let Err(e) = crate::orchestration::send_review(session_id.clone(), prompt, sink.clone()).await {
        if let Some(path) = written {
            let _ = tokio::fs::remove_file(path).await;
        }
        return Err(e.into());
    }
    let payload =
        AgentEventPayload::SecretAnswered { request_id, name, outcome, kept: false, always: false, auto: false, task: None, from: None };
    manager().log_event(&session_id, item.harness, payload, &sink).await?;
    open.remove(at);
    write_pending(open).await?;
    Ok(())
}

/// What a bot's task is told of a secret sent from its bot's machine.
fn bot_prompt(name: &str, path: &Path) -> String {
    let path = path.display();
    format!(
        "The user gave you {name} from your bot's machine. Its value is in the file {path} here, readable only by this user, and deleted after 24 hours. \
         Ask with `dray secret request {name}` again when you need it after that: your bot's machine keeps the saved ones. \
         Use it inside the command that needs it: redirect the file into a command that reads it on stdin (<command> < {path}), pass it to a flag that takes a file, \
         or set it for that one command, like {name}=\"$(cat {path})\" <command>. A login command that stores the credential wants stdin: a variable set beside it can stop it storing anything. \
         Never print, echo or log the value, never copy it into another file, a commit or a message, and never ask the user for it in chat. \
         Carry on with what you needed it for."
    )
}

/// A relayed card's answer, as the reader gave it.
#[cfg(any(feature = "serve", feature = "desktop"))]
struct Relayed {
    value: Option<String>,
    keep: bool,
    use_saved: bool,
    always: bool,
    from: Option<String>,
}

/// The bot's server, given a task's ask collected from `saved`: an
/// name agents may use without asking is sent at once; anything else draws a card in
/// `chat`, the bot chat the task reports to. An ask already carded is left.
#[cfg(any(feature = "serve", feature = "desktop"))]
pub async fn relay(saved: &crate::machines::Saved, ask: BotAsk, chat: &str, app: &Sink) {
    if let Err(e) = relay_one(saved, ask, chat, app).await {
        eprintln!("[secrets] relay from {}: {e:#}", saved.name);
    }
}

#[cfg(any(feature = "serve", feature = "desktop"))]
async fn relay_one(saved: &crate::machines::Saved, ask: BotAsk, chat: &str, app: &Sink) -> Result<()> {
    let _held = LOCK.lock().await;
    let mut open = read_pending().await?;
    let carded = |e: &AgentEvent| {
        matches!(&e.payload, AgentEventPayload::SecretRequested { task: Some(t), .. }
            if t.request_id == ask.request_id && t.machine_id == saved.id)
    };
    if open.iter().any(carded) {
        return Ok(());
    }
    let task = crate::events::SecretTask {
        session_id: ask.session_id.clone(),
        title: ask.title.clone(),
        machine: saved.name.clone(),
        machine_id: saved.id.clone(),
        request_id: ask.request_id.clone(),
    };
    // The task's server is the other side's word: a name becomes a path under
    // the vault and the link is opened, so both are held to what `request`
    // takes. Declined back, or the ask comes round again on every collect.
    if let Err(e) = check_name(&ask.name).and_then(|()| check_url(ask.url.as_deref())) {
        let _ = send_to_task(&task, None).await;
        return Err(e.context(format!("refused an ask from {}", saved.name)));
    }
    let chat_item = store::get_session_index_item(chat).await?.with_context(|| format!("no session {chat}"))?;
    let names = saved_names().await;
    let resolved = resolve(&ask.name, &names).await;
    let auto = match &resolved {
        Some(r) if read_always().await.contains(r) => saved_path(r).await?,
        _ => None,
    };
    if let Some(path) = &auto {
        let value = tokio::fs::read_to_string(path).await?;
        // A delivery that fails here would leave the task waiting on a card
        // nobody sees, so the reader gets the card and its error instead.
        if let Err(e) = send_to_task(&task, Some(value)).await {
            eprintln!("[secrets] auto-use to {} failed, drawing the card: {e}", saved.name);
        } else {
            let payload = AgentEventPayload::SecretAnswered {
                request_id: uuid::Uuid::new_v4().to_string(),
                from: resolved.clone().filter(|r| *r != ask.name),
                name: ask.name,
                outcome: SecretOutcome::Used,
                kept: true,
                always: true,
                auto: true,
                task: Some(task),
            };
            manager().log_event(&chat_item.session_id, chat_item.harness, payload, app).await?;
            return Ok(());
        }
    }
    let payload = AgentEventPayload::SecretRequested {
        request_id: uuid::Uuid::new_v4().to_string(),
        saved: names.contains(&ask.name),
        closest: resolved.or_else(|| closest_name(&ask.name, &names)),
        name: ask.name,
        label: ask.label,
        reason: ask.reason,
        url: ask.url,
        saved_names: names,
        bot: false,
        task: Some(task),
    };
    let event = manager().log_event(&chat_item.session_id, chat_item.harness, payload, app).await?;
    open.push(event);
    write_pending(open).await?;
    Ok(())
}

/// Closes the cards relayed here from tasks on `saved` that no longer ask,
/// each withdrawn there with `dray secret cancel`. `asks` is that machine's
/// whole answer to this round's collect, so an ask missing from it is gone.
/// One answered from here closes under this lock, which it holds from sending
/// its answer to the task until the card is dropped.
#[cfg(any(feature = "serve", feature = "desktop"))]
pub async fn withdraw_relayed(saved: &crate::machines::Saved, asks: &[BotAsk], app: &Sink) {
    let _held = LOCK.lock().await;
    let Ok(mut open) = read_pending().await else { return };
    let stale = |e: &AgentEvent| relay_withdrawn(e, &saved.id, asks);
    if !open.iter().any(stale) {
        return;
    }
    let (gone, kept): (Vec<AgentEvent>, Vec<AgentEvent>) = open.drain(..).partition(stale);
    for card in gone {
        let AgentEventPayload::SecretRequested { request_id, name, task, .. } = card.payload else { continue };
        let Ok(Some(chat)) = store::get_session_index_item(&card.session_id).await else { continue };
        let payload = closed(&request_id, &name, SecretOutcome::Withdrawn, task);
        if let Err(e) = manager().log_event(&chat.session_id, chat.harness, payload, app).await {
            eprintln!("[secrets] could not close {name}'s card from {}: {e:#}", saved.name);
        }
    }
    if let Err(e) = write_pending(kept).await {
        eprintln!("[secrets] could not drop withdrawn cards from {}: {e:#}", saved.name);
    }
}

/// Sends a relayed card's answer to the task's machine, encrypted in transit.
#[cfg(any(feature = "serve", feature = "desktop"))]
async fn send_to_task(task: &crate::events::SecretTask, value: Option<String>) -> Result<(), String> {
    let machines = crate::machines::load().await;
    let saved = machines
        .iter()
        .find(|m| m.id == task.machine_id)
        .ok_or_else(|| format!("{} is no longer one of this machine's machines", task.machine))?;
    let args = serde_json::json!({ "sessionId": task.session_id, "requestId": task.request_id, "value": value });
    crate::machines::call_private(saved, "secret_deliver", args).await.map(drop)
}

/// The reader answered a card relayed from a task on another machine: the
/// value is kept here where asked (this is the bot's machine, its vault),
/// and sent to the task's machine as a one-time file.
#[cfg(any(feature = "serve", feature = "desktop"))]
async fn answer_relayed(
    chat: &str,
    request_id: &str,
    name: &str,
    task: crate::events::SecretTask,
    answer: Relayed,
    sink: &Sink,
) -> Result<(), Fail> {
    let Relayed { value, keep, use_saved, always, from } = answer;
    let used = from.unwrap_or_else(|| name.to_string());
    let (value, outcome) = match value {
        _ if use_saved => {
            let path = saved_path(&used).await?.with_context(|| format!("{used} is no longer saved here; paste it instead"))?;
            set_alias(name, Some(&used)).await?;
            (Some(tokio::fs::read_to_string(path).await.map_err(anyhow::Error::from)?), SecretOutcome::Used)
        }
        Some(value) => {
            let value = value.trim().to_string();
            if value.is_empty() {
                return Err(anyhow::anyhow!("paste the value first").into());
            }
            if value.len() > MAX_VALUE {
                return Err(anyhow::anyhow!("that is longer than a secret should be").into());
            }
            remember(&value);
            (Some(value), SecretOutcome::Saved)
        }
        None => (None, SecretOutcome::Declined),
    };
    // Sent before anything is kept or logged, so a machine that does not
    // answer leaves the card open to retry.
    send_to_task(&task, value.clone()).await.map_err(anyhow::Error::msg)?;
    let kept = match (&value, outcome) {
        (Some(v), SecretOutcome::Saved) if keep => {
            write_private(dir(Some("saved")).await?.join(name), v.clone()).await?;
            true
        }
        (_, SecretOutcome::Used) => true,
        _ => false,
    };
    let always = always && kept;
    let used = if outcome == SecretOutcome::Used { used } else { name.to_string() };
    if always {
        set_always(&used, true).await?;
    }
    let item = store::get_session_index_item(chat).await?.context("no such session")?;
    let payload = AgentEventPayload::SecretAnswered {
        request_id: request_id.to_string(),
        name: name.to_string(),
        outcome,
        kept,
        always,
        auto: false,
        from: (used != name).then_some(used),
        task: Some(task),
    };
    manager().log_event(chat, item.harness, payload, sink).await?;
    if kept {
        sink.emit(SECRETS_CHANGED, ()).ok();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(any(feature = "serve", feature = "desktop"))]
    fn a_secret_crosses_machines_only_encrypted() {
        use crate::machines::private_url;
        for ok in ["wss://box.example/x", "ws://127.0.0.1:7391", "ws://localhost:9", "ws://[::1]:9"] {
            assert!(private_url(ok), "{ok}");
        }
        for bad in ["ws://203.0.113.7:7317", "ws://box.lan", "http://127.0.0.1", "ws://127.0.0.1.evil.com:1"] {
            assert!(!private_url(bad), "{bad}");
        }
    }

    #[test]
    fn the_closest_saved_name_shares_a_real_word() {
        let saved = ["GITHUB_TOKEN".to_string(), "NPM_TOKEN".to_string(), "OPENAI_API_KEY".to_string()];
        assert_eq!(closest_name("GITHUB_TOKEN", &saved).as_deref(), Some("GITHUB_TOKEN"));
        assert_eq!(closest_name("GH_TOKEN", &saved).as_deref(), Some("GITHUB_TOKEN"));
        assert_eq!(closest_name("OPENAI_KEY", &saved).as_deref(), Some("OPENAI_API_KEY"));
        assert_eq!(closest_name("CARGO_TOKEN", &saved), None, "TOKEN alone is no match");
        assert_eq!(closest_name("STRIPE_KEY", &[]), None);
    }

    fn card(session_id: &str, name: &str, task: Option<crate::events::SecretTask>) -> AgentEvent {
        AgentEvent {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.into(),
            harness: crate::harness::Harness::ClaudeCode,
            seq: 1,
            ts: String::new(),
            turn_id: None,
            subagent: None,
            payload: AgentEventPayload::SecretRequested {
                request_id: "r1".into(),
                name: name.into(),
                label: None,
                reason: "why".into(),
                url: None,
                saved: false,
                saved_names: Vec::new(),
                closest: None,
                bot: false,
                task,
            },
        }
    }

    fn task(machine_id: &str, request_id: &str) -> crate::events::SecretTask {
        crate::events::SecretTask {
            session_id: "task".into(),
            title: "Task".into(),
            machine: "vps".into(),
            machine_id: machine_id.into(),
            request_id: request_id.into(),
        }
    }

    #[test]
    fn a_session_takes_back_only_its_own_card() {
        let mine = card("a", "GH_TOKEN", None);
        assert!(own_card(&mine, "a", "GH_TOKEN"));
        assert!(!own_card(&mine, "b", "GH_TOKEN"), "another session's card");
        assert!(!own_card(&mine, "a", "NPM_TOKEN"), "another name");
        let relayed = card("a", "GH_TOKEN", Some(task("m1", "t1")));
        assert!(!own_card(&relayed, "a", "GH_TOKEN"), "a task's card in the bot's chat is the task's");
    }

    #[test]
    fn a_relayed_card_closes_once_its_ask_is_gone() {
        let ask = |request_id: &str| BotAsk {
            request_id: request_id.into(),
            session_id: "task".into(),
            child: "task".into(),
            title: "Task".into(),
            name: "GH_TOKEN".into(),
            label: None,
            reason: "why".into(),
            url: None,
        };
        let relayed = card("bot", "GH_TOKEN", Some(task("m1", "t1")));
        assert!(!relay_withdrawn(&relayed, "m1", &[ask("t1")]), "still asking");
        assert!(relay_withdrawn(&relayed, "m1", &[ask("t2")]));
        assert!(relay_withdrawn(&relayed, "m1", &[]));
        assert!(!relay_withdrawn(&relayed, "m2", &[]), "another machine's answer says nothing of it");
        assert!(!relay_withdrawn(&card("bot", "GH_TOKEN", None), "m1", &[]), "the bot's own card");
    }

    #[test]
    fn a_name_reads_like_an_env_var() {
        for ok in ["GITHUB_TOKEN", "_x", "a1", "CLOUDFLARE_API_TOKEN"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["", "1ABC", "has space", "../etc", "a/b", "a.b", "toolong".repeat(10).as_str()] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_card_link_is_http_or_https() {
        for ok in [None, Some("https://github.com/settings/tokens"), Some("http://localhost:3000")] {
            assert!(check_url(ok).is_ok(), "{ok:?}");
        }
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "ssh://host", "github.com"] {
            assert!(check_url(Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn masking_blanks_the_value_and_its_escaped_form() {
        remember("s3cr3t-\"quoted\"-value");
        remember("short");
        let raw = "token is s3cr3t-\"quoted\"-value here";
        assert_eq!(mask_text(raw).as_deref(), Some("token is •••••••• here"));
        let json = serde_json::to_string(raw).unwrap();
        assert!(!mask_text(&json).unwrap().contains("s3cr3t"));
        assert_eq!(mask_text("a short word"), None);
    }

    #[test]
    fn the_prompts_name_the_path_and_never_ask_in_chat() {
        let once = saved_prompt("GH_TOKEN", Path::new("/h/.dray/secrets/once/GH_TOKEN-1"), false, false);
        assert!(once.contains("GH_TOKEN=\"$(cat /h/.dray/secrets/once/GH_TOKEN-1)\""));
        assert!(once.contains("< /h/.dray/secrets/once/GH_TOKEN-1"));
        assert!(once.contains("24 hours"));
        let kept = saved_prompt("GH_TOKEN", Path::new("/p"), true, false);
        assert!(kept.contains("one click"));
        assert!(saved_prompt("GH_TOKEN", Path::new("/p"), true, true).contains("without asking"));
        assert!(declined_prompt("GH_TOKEN").contains("Don't ask for it in chat"));
    }

    #[tokio::test]
    async fn a_private_file_is_owner_only() {
        let dir = std::env::temp_dir().join(format!("dray-secret-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("X");
        write_private(path.clone(), "v1".into()).await.unwrap();
        write_private(path.clone(), "v2".into()).await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "v2");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no temp left behind");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
