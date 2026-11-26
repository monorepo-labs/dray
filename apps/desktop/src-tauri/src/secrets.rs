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
use dray_proto::{RequestSecret, Response, SecretSummary};
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
    if url.as_deref().is_some_and(|u| !u.starts_with("https://") && !u.starts_with("http://")) {
        bail!("--url takes an http or https link");
    }
    let chat = store::get_session_index_item(&ask.session_id)
        .await?
        .with_context(|| format!("no session {}", ask.session_id))?;
    let label = tidy(ask.label);
    if bot_root(&chat).await.is_some() {
        return ask_bot(chat, name, label, reason, url, app).await;
    }

    let _held = LOCK.lock().await;
    let saved = saved_path(&name).await?;
    if let (Some(path), true) = (&saved, read_always().await.contains(&name)) {
        // Used without asking: no card, and the path goes back in the tool's own answer.
        let payload = AgentEventPayload::SecretAnswered {
            request_id: uuid::Uuid::new_v4().to_string(),
            name: name.clone(),
            outcome: SecretOutcome::Used,
            kept: true,
            always: true,
            auto: true,
            to: None,
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
                let payload = AgentEventPayload::SecretAnswered {
                    request_id: request_id.to_string(),
                    name: name.clone(),
                    outcome: SecretOutcome::Replaced,
                    kept: false,
                    always: false,
                    auto: false,
                    to: None,
                };
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
        saved: saved.is_some(),
        bot: false,
        task: None,
    };
    let event = manager().log_event(&chat.session_id, chat.harness, payload, app).await?;
    open.push(event);
    write_pending(open).await?;
    Ok(Response::SecretRequested { request_id, name, replaced, path: None, bot: false })
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
    sink: Sink,
) -> Result<(), Fail> {
    let use_saved = use_saved.unwrap_or(false);
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
        let answer = Relayed { value, keep, use_saved, always };
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
            let path = saved_path(&name).await?.with_context(|| format!("{name} is no longer saved here; paste it instead"))?;
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
    if always {
        set_always(&name, true).await?;
    }
    let payload = AgentEventPayload::SecretAnswered { request_id, name, outcome, kept, always, auto: false, to: None };
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

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_secret(name: String, sink: Sink) -> Result<(), Fail> {
    check_name(&name)?;
    set_always(&name, false).await?;
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
                let payload = AgentEventPayload::SecretAnswered {
                    request_id: request_id.to_string(),
                    name: name.clone(),
                    outcome: SecretOutcome::Replaced,
                    kept: false,
                    always: false,
                    auto: false,
                    to: None,
                };
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
        AgentEventPayload::SecretAnswered { request_id, name, outcome, kept: false, always: false, auto: false, to: None };
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
    let chat_item = store::get_session_index_item(chat).await?.with_context(|| format!("no session {chat}"))?;
    let task = crate::events::SecretTask {
        session_id: ask.session_id.clone(),
        title: ask.title.clone(),
        machine: saved.name.clone(),
        machine_id: saved.id.clone(),
        request_id: ask.request_id.clone(),
    };
    let saved_here = saved_path(&ask.name).await?;
    if let (Some(path), true) = (&saved_here, read_always().await.contains(&ask.name)) {
        let value = tokio::fs::read_to_string(path).await?;
        send_to_task(&task, Some(value)).await.map_err(anyhow::Error::msg)?;
        let payload = AgentEventPayload::SecretAnswered {
            request_id: uuid::Uuid::new_v4().to_string(),
            name: ask.name,
            outcome: SecretOutcome::Used,
            kept: true,
            always: true,
            auto: true,
            to: Some(ask.title),
        };
        manager().log_event(&chat_item.session_id, chat_item.harness, payload, app).await?;
        return Ok(());
    }
    let payload = AgentEventPayload::SecretRequested {
        request_id: uuid::Uuid::new_v4().to_string(),
        name: ask.name,
        label: ask.label,
        reason: ask.reason,
        url: ask.url,
        saved: saved_here.is_some(),
        bot: false,
        task: Some(task),
    };
    let event = manager().log_event(&chat_item.session_id, chat_item.harness, payload, app).await?;
    open.push(event);
    write_pending(open).await?;
    Ok(())
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
    let Relayed { value, keep, use_saved, always } = answer;
    let (value, outcome) = match value {
        _ if use_saved => {
            let path = saved_path(name).await?.with_context(|| format!("{name} is no longer saved here; paste it instead"))?;
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
    if always {
        set_always(name, true).await?;
    }
    let item = store::get_session_index_item(chat).await?.context("no such session")?;
    let payload = AgentEventPayload::SecretAnswered {
        request_id: request_id.to_string(),
        name: name.to_string(),
        outcome,
        kept,
        always,
        auto: false,
        to: Some(task.title),
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
    fn a_name_reads_like_an_env_var() {
        for ok in ["GITHUB_TOKEN", "_x", "a1", "CLOUDFLARE_API_TOKEN"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["", "1ABC", "has space", "../etc", "a/b", "a.b", "toolong".repeat(10).as_str()] {
            assert!(!valid_name(bad), "{bad}");
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
