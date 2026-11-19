use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use ts_rs::TS;

pub mod learn;
pub mod react;

use crate::{
    events::ApprovalPolicy,
    models::{Effort, ModelId},
    session::{manager, Harness},
    sink::Sink,
    store::{get_home_app_dir, read_json, write_atomic, SessionIndexItem},
    Fail,
};

/// A bot: one long-lived chat with instructions and memory of its own, which
/// everything it spawns reports back to after every turn.
///
/// It is a folder, `bots/<id>/` under the home, holding [`INSTRUCTIONS`] and
/// [`MEMORY`]; the bot's session runs *in* that folder, which is how a session
/// is known to be a bot's — no field on the index says so, so an older build
/// reading the index loses nothing. `bots.json` holds only the list.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "events.ts")]
pub struct Bot {
    pub id: String,
    pub name: String,
    /// The bot's folder: its session's cwd. Absolute, on the server holding it.
    pub path: String,
    pub created: String,
    /// The face picked when it was made. `None` for a bot made before there
    /// was a pick, which then draws the face its id seeds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<BotAvatar>,
    /// Marks a bot whose chat opens on a welcome, drawn by the app and written
    /// to the log when a session starts. Dray Bot's alone; a bot made with New
    /// bot greets with a real turn. The words drawn are `greeting`'s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub welcome: Option<String>,
    /// The messages its chat opens on, worked out by `list_bots` on every read
    /// and never saved: the welcome in today's words, then the question for
    /// the user's name while no bot knows it. Empty with no welcome.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub greeting: Vec<String>,
}

/// A Blobatar face: which silhouette and which hue. Strings and degrees rather
/// than the library's 0–1 trait positions, so a later generation of the
/// library moving its cut points cannot change a face somebody picked.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "events.ts")]
pub struct BotAvatar {
    pub shape: String,
    pub hue: f64,
}

/// The bot's job and standing rules. `AGENTS.md` because every harness Dray
/// runs loads it from its cwd on its own: Codex, pi, fx and grok natively,
/// Claude Code through [`CLAUDE_POINTER`]. Dray injects none of it.
pub const INSTRUCTIONS: &str = "AGENTS.md";
/// Where a bot made before #1118 kept its instructions. Moved to
/// [`INSTRUCTIONS`] at its next spawn; still read so an old Learned row undoes.
pub const LEGACY_INSTRUCTIONS: &str = "INSTRUCTIONS.md";
/// Claude Code reads `CLAUDE.md`, so this one imports [`INSTRUCTIONS`]. Its
/// own `AGENTS.md` fallback skips a folder holding a `CLAUDE.md`, and with
/// both on it never loads an imported file twice, so the file lands once
/// under every setting. Ignored by the folder's git, since grok skips an
/// ignored rules file and would otherwise read the pointer beside the file it
/// points at; that also keeps Dray's file out of the bot's history.
const CLAUDE_POINTER: &str = "CLAUDE.md";
const POINTER_TEXT: &str = "@AGENTS.md\n";
/// A folder, one `YYYY-MM-DD-title.md` per memory. Never put in the prompt:
/// the bot lists and greps it when it needs to, so it costs nothing to keep.
pub const MEMORY: &str = "memory";

/// Past this the bot is told to ask the user what to cut. The agent loads the
/// file whole, so one let grow without bound crowds out the conversation.
const FILE_CAP: usize = 16_000;

static BOTS_LOCK: Mutex<()> = Mutex::const_new(());

async fn bots_dir() -> Result<PathBuf> {
    Ok(get_home_app_dir().await?.join("bots"))
}

async fn list_path() -> Result<PathBuf> {
    Ok(get_home_app_dir().await?.join("bots.json"))
}

/// Every bot on this server, oldest first. The app's own server makes Dray Bot
/// the first time anything asks, so every user starts with one; a `dray-serve`
/// makes none, or each remote added would put another in the sidebar.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_bots() -> Result<Vec<Bot>, Fail> {
    if let Err(e) = ensure_dray_bot().await {
        eprintln!("[dray bot] {e:#}");
    }
    let mut bots = read_list().await?;
    let user = user_name().await;
    for bot in &mut bots {
        bot.greeting = greeting(bot, user.as_deref());
    }
    Ok(bots)
}

/// Every bot here as saved, with none made and no greeting worded: what a
/// background reader wants, where `list_bots` makes Dray Bot on first ask.
pub(crate) async fn bots_here() -> Vec<Bot> {
    read_list().await.unwrap_or_default()
}

async fn read_list() -> Result<Vec<Bot>, Fail> {
    Ok(read_json(&list_path().await?).await?)
}

/// The default bot's name, face and the welcome its chat opens on.
pub const DRAY_BOT: &str = "Dray Bot";
/// Dray Bot's welcome: who it is and what it does, as Grok Bot's opens. Built
/// from the bot's name of the moment, so a renamed Dray Bot says its new one.
fn welcome_text(name: &str, user: Option<&str>) -> String {
    let hello = match user {
        Some(user) => format!("Hi {user}!"),
        None => "Hi!".to_string(),
    };
    format!(
        "{hello} I'm {name}, your new assistant for everything you build. \
I can start and keep track of work across your projects."
    )
}

/// The second message of a bot's first greeting while no bot knows the user's name.
pub const ASK_NAME: &str = "What should I call you?";

/// What a bot with a welcome opens on. The stored welcome only marks one:
/// the words are rebuilt, so the names in them are today's.
fn greeting(bot: &Bot, user: Option<&str>) -> Vec<String> {
    if bot.welcome.is_none() {
        return Vec::new();
    }
    let mut messages = vec![welcome_text(&bot.name, user)];
    if user.is_none() {
        messages.push(ASK_NAME.to_string());
    }
    messages
}

/// A bot writes the name the user wants to be called here, in its own folder,
/// where every harness's sandbox lets it write. Dray copies it to
/// [`user_name_path`] after the turn, so every bot shares one name.
pub const USER_FILE: &str = "USER.md";

async fn user_name_path() -> Result<PathBuf> {
    Ok(bots_dir().await?.join(".user-name"))
}

/// The name the user asked the bots to call them, once one was told. Never
/// guessed from git or the account: the user is asked instead (#1076).
pub async fn user_name() -> Option<String> {
    let text = tokio::fs::read_to_string(user_name_path().await.ok()?).await.ok()?;
    clean_name(&text)
}

/// The first line of what a bot wrote, cut to a name. It rides every bot's
/// prompt, so it is one short line holding nothing that could close a block.
fn clean_name(text: &str) -> Option<String> {
    let line = text.lines().map(|l| l.trim().trim_start_matches('#').trim()).find(|l| !l.is_empty())?;
    let name: String = line
        .chars()
        .filter(|c| !matches!(c, '"' | '`' | '<' | '>' | '[' | ']' | '{' | '}'))
        .take(60)
        .collect();
    let name = name.trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// Takes up the name a bot wrote to its [`USER_FILE`] in `commit`, and tells
/// every other bot's chat.
async fn learn_user_name(bot: &Bot, commit: &str, sink: &Sink) {
    let dir = Path::new(&bot.path);
    let Ok(changed) = git(dir, &["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).await else {
        return;
    };
    // Only a change made in this commit: a bot told a name long ago keeps its
    // file, and copying it every turn would undo a newer name another bot heard.
    if !changed.lines().any(|f| f == USER_FILE) {
        return;
    }
    let Some(name) = clean_name(&read_file(&dir.join(USER_FILE)).await) else { return };
    // Two bots told at once would share `write_atomic`'s temp file, and the
    // name saved could differ from the one their notes carry.
    static USER_NAME_LOCK: Mutex<()> = Mutex::const_new(());
    let _guard = USER_NAME_LOCK.lock().await;
    if user_name().await.as_deref() == Some(name.as_str()) {
        return;
    }
    let written = match user_name_path().await {
        Ok(path) => write_atomic(&path, &name).await,
        Err(e) => Err(e),
    };
    if let Err(e) = written {
        eprintln!("[user name] {e:#}");
        return;
    }
    for other in read_list().await.unwrap_or_default().iter().filter(|b| b.id != bot.id) {
        note_bot(&other.path, Note::UserName, format!("The user asked to be called {name}. Call them that from now on."));
    }
    // Every greeting not yet sent is worded from the name, so open apps read them again.
    sink.emit(BOTS_CHANGED, ()).ok();
}

/// Makes Dray Bot once per home, on the app's own server alone. A marker file
/// rather than a look at the list, so a reader who deletes it is not handed it
/// back on the next read.
async fn ensure_dray_bot() -> Result<()> {
    if !cfg!(feature = "desktop") {
        return Ok(());
    }
    let marker = bots_dir().await?.join(".dray-bot-made");
    if tokio::fs::try_exists(&marker).await.unwrap_or(false) {
        return Ok(());
    }
    let _guard = BOTS_LOCK.lock().await;
    // Again under the lock: two first reads at once must not make two.
    if tokio::fs::try_exists(&marker).await.unwrap_or(false) {
        return Ok(());
    }
    // A Dray Bot already in the list is one made before its marker could be
    // written — a stop between the two writes. Only it carries a welcome.
    if !read_list().await?.iter().any(|b| b.welcome.is_some()) {
        // The nub in blue (#1076). What is stored as the welcome only marks
        // the bot as one: `greeting` rebuilds the words on every read.
        let avatar = BotAvatar { shape: "nub".into(), hue: 250.0 };
        make_bot(DRAY_BOT.into(), Some(avatar), Some(welcome_text(DRAY_BOT, None))).await?;
    }
    tokio::fs::create_dir_all(bots_dir().await?).await?;
    write_atomic(&marker, "").await?;
    Ok(())
}

/// New chats whose first prompt is to be logged after their bot's welcome.
/// Marked at creation rather than read off the event counter: a harness can
/// log a startup error before the first prompt, which moved the counter on
/// and lost the welcome.
static WELCOMES: std::sync::Mutex<Vec<(String, Vec<String>)>> = std::sync::Mutex::new(Vec::new());

/// Marks `session_id` for `bot`'s greeting, and hands the agent the same
/// words ahead of the first prompt: it never wrote them, and the user's first
/// message may be the answer to its "What should I call you?".
async fn mark_welcome(session_id: &str, bot: &Bot) {
    let messages = greeting(bot, user_name().await.as_deref());
    if messages.is_empty() {
        return;
    }
    let quoted: Vec<String> = messages.iter().map(|m| format!("> {m}")).collect();
    restore_handover(
        session_id,
        format!(
            "[Dray: your chat opened on these messages of yours, which the user has read:\n\n{}\n\nThe user's first message follows.]\n\n",
            quoted.join("\n>\n")
        ),
    );
    WELCOMES.lock().unwrap().push((session_id.to_string(), messages));
}

/// Marks a new chat in `cwd`: for the conversation so far where the bot has
/// talked before, which is an agent switch, else for its welcome.
pub async fn mark_new_chat(session_id: &str, cwd: &str, harness: Harness) {
    let Some(bot) = bot_at(cwd).await else { return };
    let earlier: Vec<SessionIndexItem> = chat_sessions(&bot.path)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|i| i.session_id != session_id)
        .collect();
    if earlier.is_empty() {
        mark_welcome(session_id, &bot).await;
        return;
    }
    // The chat moves to the new agent, so the old one has nothing left to do.
    for item in &earlier {
        manager().stop(&item.session_id).await;
    }
    let text = handover_prompt(&earlier, harness).await;
    restore_handover(session_id, text);
}

/// Marks a chat being resumed that took over from an earlier agent and has no
/// reply yet: its first send failed, or a restart lost the mark made at
/// creation, and the agent may never have been handed the conversation. A
/// second copy after a reply that never landed costs nothing.
pub async fn mark_handover_if_unanswered(session_id: &str, cwd: &str, harness: Harness) {
    if bot_at(cwd).await.is_none() || HANDOVERS.lock().unwrap().iter().any(|(id, _)| id == session_id) {
        return;
    }
    let chats = chat_sessions(cwd).await.unwrap_or_default();
    let Some(at) = chats.iter().position(|i| i.session_id == session_id) else { return };
    if at == 0 {
        return;
    }
    let events = crate::store::list_session_events(session_id).await.unwrap_or_default();
    let answered = events
        .iter()
        .any(|e| e.subagent.is_none() && matches!(e.payload, crate::events::AgentEventPayload::AssistantText { .. }));
    if !answered {
        let text = handover_prompt(&chats[..at], harness).await;
        restore_handover(session_id, text);
    }
}

/// Marks a chat being resumed whose log holds no prompt yet: its first send
/// failed before the welcome was written, and a restart lost the mark made at
/// creation. Reads the log only for a bot that has a welcome.
pub async fn mark_welcome_if_unlogged(session_id: &str, cwd: &str) {
    let Some(bot) = bot_at(cwd).await else { return };
    if bot.welcome.is_none() {
        return;
    }
    // A chat that took over from an earlier one: the welcome sits at the start
    // of that one.
    let chats = chat_sessions(&bot.path).await.unwrap_or_default();
    if chats.first().is_some_and(|first| first.session_id != session_id) {
        return;
    }
    if WELCOMES.lock().unwrap().iter().any(|(id, _)| id == session_id) {
        return;
    }
    let Ok(dir) = crate::store::get_sessions_dir().await else { return };
    let log = tokio::fs::read_to_string(dir.join(format!("{session_id}.jsonl"))).await.unwrap_or_default();
    // Neither a prompt nor the welcome itself: a stop between saving the two
    // must not have it written twice.
    if !log.contains("\"user_message\"") && !log.contains("\"assistant_text\"") {
        mark_welcome(session_id, &bot).await;
    }
}

/// The greeting to log ahead of `session_id`'s first prompt, taken once.
pub fn take_welcome(session_id: &str) -> Option<Vec<String>> {
    let mut welcomes = WELCOMES.lock().unwrap();
    let at = welcomes.iter().position(|(id, _)| id == session_id)?;
    Some(welcomes.remove(at).1)
}

/// New chats taking over from an earlier agent, with the hand-over each sends
/// ahead of its first prompt. Never logged: the earlier logs already hold the
/// conversation, and a copy would be a second record that can drift.
static HANDOVERS: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

/// The hand-over to send ahead of `session_id`'s first prompt, taken once.
pub fn take_handover(session_id: &str) -> Option<String> {
    let mut handovers = HANDOVERS.lock().unwrap();
    let at = handovers.iter().position(|(id, _)| id == session_id)?;
    Some(handovers.remove(at).1)
}

/// Queues a hand-over, or puts one back after a send that failed, so the
/// retry still carries the conversation.
pub fn restore_handover(session_id: &str, text: String) {
    let mut handovers = HANDOVERS.lock().unwrap();
    if !handovers.iter().any(|(id, _)| id == session_id) {
        handovers.push((session_id.to_string(), text));
    }
}

/// What the reader did to a bot's tasks since the bot's last prompt, per bot
/// folder: each task's id, title and acts, oldest first. Sent ahead of the
/// next prompt the bot gets anyway, since waking it for each would cost a turn.
// ponytail: in memory, so a server restart drops what was not yet sent; a
// file beside bots.json if that ever matters.
static SINCE: std::sync::Mutex<Vec<(String, Vec<(String, String, Vec<String>)>)>> =
    std::sync::Mutex::new(Vec::new());

/// Tasks kept per bot, newest kept: the list rides a prompt, so it stays short.
const SINCE_CAP: usize = 8;

/// An act of the reader's on a session, through a client.
pub enum Act {
    Settled,
    Stopped,
    Deleted,
}

/// Runs `run`, the reader's own `act` on `session_id`, and notes it for the
/// bot whose task that is. Called from the client wire alone, never from
/// `dray`, which is how the bot itself settles and stops its tasks.
pub async fn reader_did<T, E>(
    session_id: &str,
    act: Option<Act>,
    run: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let Some(act) = act else { return run.await };
    let item = crate::store::get_session_index_item(session_id).await.ok().flatten();
    // Only an act that changes something: settling a settled task or stopping
    // an idle one tells the bot nothing.
    let counts = match act {
        Act::Settled => item.as_ref().is_some_and(|i| !i.archived),
        Act::Stopped => manager().turn_in_flight(session_id).await,
        Act::Deleted => true,
    };
    let text = match act {
        Act::Settled => "settled it",
        Act::Stopped => "stopped its turn",
        Act::Deleted => "deleted it",
    };
    // A stop is noted ahead of the act: the stopped task reports at once, and
    // that report has to carry why the turn ended. Anything else once it landed,
    // since a note already sent cannot be taken back.
    let early = matches!(act, Act::Stopped);
    let noted = match (counts && early, &item) {
        (true, Some(item)) => note_since(item, text.to_string()).await,
        _ => None,
    };
    let out = run.await;
    if let (Ok(_), true, false, Some(item)) = (&out, counts, early, &item) {
        note_since(item, text.to_string()).await;
    }
    if let (Err(_), Some(bot), Some(item)) = (&out, noted, &item) {
        let mut since = SINCE.lock().unwrap();
        if let Some((_, tasks)) = since.iter_mut().find(|(path, _)| *path == bot) {
            for (_, _, acts) in tasks.iter_mut().filter(|(id, ..)| *id == item.session_id) {
                acts.retain(|a| a != text);
            }
            tasks.retain(|(_, _, acts)| !acts.is_empty());
        }
    }
    out
}

/// Notes `act` against `task` for its bot, folded into the task's line, and
/// answers the bot's folder where it was noted.
pub async fn note_since(task: &SessionIndexItem, act: String) -> Option<String> {
    let chat = bot_chat_of(task).await?;
    // The bot's own chat: the reader acting there is a turn the bot sees.
    if chat.session_id == task.session_id {
        return None;
    }
    let mut since = SINCE.lock().unwrap();
    let at = match since.iter().position(|(path, _)| same_dir(path, &chat.cwd)) {
        Some(at) => at,
        None => {
            since.push((chat.cwd.clone(), Vec::new()));
            since.len() - 1
        }
    };
    // The title is the one piece of free text, and it sits inside a list the
    // bot is told to trust: kept to one line that cannot close the list.
    let title = task.title.replace(['\n', '\r', ']', '"'], " ");
    fold_since(&mut since[at].1, &task.session_id, &title, act);
    Some(since[at].0.clone())
}

fn fold_since(tasks: &mut Vec<(String, String, Vec<String>)>, id: &str, title: &str, act: String) {
    match tasks.iter_mut().find(|(task, ..)| task == id) {
        Some((_, _, acts)) if acts.contains(&act) => {}
        Some((_, _, acts)) => acts.push(act),
        None => tasks.push((id.to_string(), title.to_string(), vec![act])),
    }
    if tasks.len() > SINCE_CAP {
        tasks.remove(0);
    }
}

/// Notes the reader's merge of PR `number` against the bot task whose branch
/// it is. `cwd` is the repo root or the task's own tree, whichever the client
/// merged from. Asks GitHub for the branch only where a bot task could match.
pub async fn note_merge(cwd: &str, number: u64) {
    let items = crate::store::list_session_index_items(false).await.unwrap_or_default();
    let mut tasks = Vec::new();
    for item in items {
        if (same_dir(&item.project_path, cwd) || same_dir(&item.cwd, cwd)) && in_bot_tree(&item).await {
            tasks.push(item);
        }
    }
    if tasks.is_empty() {
        return;
    }
    let Some(branch) = crate::github::pr_head(cwd, number).await else { return };
    let branch = branch.as_str();
    for task in tasks {
        // The tree's own HEAD first: a task can move off the branch it was made on.
        let observed = if task.worktree_removed { None } else { crate::git::current_branch(&task.cwd).await };
        if crate::store::session_branch(&task, observed.as_deref()).as_deref() == Some(branch) {
            // No PR title: it is the PR author's text, and this list is trusted.
            note_since(&task, format!("merged its PR #{number}")).await;
        }
    }
}

/// The list for the bot chat `session_id` belongs to, taken once, as the
/// hidden lines that go ahead of its next prompt.
pub async fn take_since(session_id: &str) -> Option<String> {
    if SINCE.lock().unwrap().is_empty() && NOTES.lock().unwrap().is_empty() {
        return None;
    }
    let item = crate::store::get_session_index_item(session_id).await.ok().flatten()?;
    let mut lines: Vec<String> = Vec::new();
    NOTES.lock().unwrap().retain(|(path, note)| {
        let mine = same_dir(path, &item.cwd);
        if mine {
            lines.push(format!("[Dray: {note}]\n\n"));
        }
        !mine
    });
    let mut since = SINCE.lock().unwrap();
    if let Some(at) = since.iter().position(|(path, _)| same_dir(path, &item.cwd)) {
        lines.push(since_text(&since.remove(at).1));
    }
    (!lines.is_empty()).then(|| lines.concat())
}

/// Facts a bot's running chat must hear before its next prompt, per bot
/// folder: a rename, or the name the user gave another bot. Its child read
/// both at spawn and would keep the old ones. In memory like [`SINCE`]: a
/// child spawned after a restart reads them in its prompt anyway.
static NOTES: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

/// What kind of note, so a newer one replaces an older one of its kind.
#[derive(PartialEq)]
enum Note {
    Renamed,
    UserName,
    Moved,
}

/// Tells the bot at `path` `note` ahead of its next prompt.
fn note_bot(path: &str, kind: Note, note: String) {
    let mut notes = NOTES.lock().unwrap();
    let tag = |k: &Note| match k {
        Note::Renamed => "The user renamed you",
        Note::UserName => "The user asked to be called",
        Note::Moved => "Your instructions moved",
    };
    notes.retain(|(p, n)| !(same_dir(p, path) && n.starts_with(tag(&kind))));
    debug_assert!(note.starts_with(tag(&kind)));
    notes.push((path.to_string(), note));
}

fn since_text(tasks: &[(String, String, Vec<String>)]) -> String {
    let lines: Vec<String> = tasks
        .iter()
        .map(|(id, title, acts)| format!("- Task \"{title}\" ({id}): the user {}.", acts.join(", then ")))
        .collect();
    format!("[Since your last turn, outside this chat:\n{}]\n\n", lines.join("\n"))
}

/// The other sessions of the bot chat `item` belongs to, unsettled. A switch
/// leaves the earlier ones open, so settling the chat has to settle them all,
/// or the previous agent's session becomes the bot's chat again.
pub async fn rest_of_chat(item: &SessionIndexItem) -> Vec<String> {
    if bot_at(&item.cwd).await.is_none() {
        return Vec::new();
    }
    chat_sessions(&item.cwd)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|i| i.session_id != item.session_id)
        .map(|i| i.session_id)
        .collect()
}

/// A bot's chat, oldest first: every unsettled session run in its folder. An
/// agent switch starts a new session, so one conversation spans several.
pub(crate) async fn chat_sessions(path: &str) -> Result<Vec<SessionIndexItem>> {
    let mut items: Vec<SessionIndexItem> = crate::store::list_session_index_items(false)
        .await?
        .into_iter()
        // A routine run shares the folder and is never the conversation.
        .filter(|i| same_dir(&i.cwd, path) && i.routine_run.is_none())
        .collect();
    items.sort_by_key(|i| chrono::DateTime::parse_from_rfc3339(&i.created).ok());
    Ok(items)
}

/// Where a message for `target` belongs: the newest session of the bot chat it
/// is part of. A task started before an agent switch still names the old
/// session as its parent, and a report sent there would wake the old agent.
pub async fn current_chat(target: SessionIndexItem) -> SessionIndexItem {
    // A routine's run shares the folder but is its own session: the bot's
    // answer to its question goes to the run.
    if target.archived || target.routine_run.is_some() || bot_at(&target.cwd).await.is_none() {
        return target;
    }
    match chat_sessions(&target.cwd).await.ok().and_then(|mut c| c.pop()) {
        Some(newest) => newest,
        None => target,
    }
}

/// How much of the conversation is replayed to the new agent, newest kept.
const HANDOVER_CAP: usize = 30_000;

/// The hidden note a new agent reads ahead of the reader's first message: the
/// conversation so far, replayed from every earlier log rather than
/// summarised, so no turn is spent and a broken old agent cannot block it.
async fn handover_prompt(earlier: &[SessionIndexItem], harness: Harness) -> String {
    let mut entries: Vec<String> = Vec::new();
    for item in earlier {
        entries.push(format!("[on {}]", item.harness.label()));
        let events = crate::store::list_session_events(&item.session_id).await.unwrap_or_default();
        entries.extend(replay(&events));
    }
    let (kept, cut) = newest_within(&entries, HANDOVER_CAP);
    let conversation = escape(&kept.join("\n\n"), "conversation");

    let mut logs = Vec::new();
    for item in earlier {
        if let Ok(path) = crate::store::get_session_path(&item.session_id).await {
            logs.push(format!("- {}", path.display()));
        }
    }
    let ids: Vec<&str> = earlier.iter().map(|i| i.session_id.as_str()).collect();
    let tasks: Vec<String> = crate::store::list_session_index_items(false)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|i| i.parent_session_id.as_deref().is_some_and(|p| ids.contains(&p)))
        .map(|i| format!("- \"{}\" ({})", i.title, i.session_id))
        .collect();
    let tasks = if tasks.is_empty() {
        String::new()
    } else {
        format!("\n\nTasks you started that are still open:\n{}", tasks.join("\n"))
    };
    let older = if cut { "Older messages are left out. " } else { "" };

    format!(
        "[Dray: the user just moved you, this bot, to {agent}. You are the same bot, with the same instructions and memory; only the agent running you changed. Below is the conversation so far, oldest first, text only. {older}The full logs, one JSON event per line, are:\n{logs}{tasks}\n\nCarry on as if you had been here all along, and don't mention this note.]\n\n<conversation>\n{conversation}\n</conversation>\n\nThe user's new message:\n\n",
        agent = harness.label(),
        logs = logs.join("\n"),
    )
}

/// The newest entries that fit in `cap` bytes, in order, and whether any were
/// cut. The entry on the boundary keeps its tail, so one long paste cannot
/// leave the new agent with nothing.
fn newest_within(entries: &[String], cap: usize) -> (Vec<String>, bool) {
    let mut kept = Vec::new();
    let mut used = 0;
    for entry in entries.iter().rev() {
        if used + entry.len() <= cap {
            used += entry.len();
            kept.push(entry.clone());
            continue;
        }
        let mut start = entry.len() - (cap - used);
        while !entry.is_char_boundary(start) {
            start += 1;
        }
        if start < entry.len() {
            kept.push(format!("…{}", &entry[start..]));
        }
        kept.reverse();
        return (kept, true);
    }
    kept.reverse();
    (kept, false)
}

/// One session's conversation as the reader saw it: their messages, the bot's
/// replies and its tasks' reports. Tool calls are left out.
fn replay(events: &[crate::events::AgentEvent]) -> Vec<String> {
    use crate::events::AgentEventPayload as P;
    events
        .iter()
        .zip(learn::in_review(events))
        .filter(|(e, review)| e.subagent.is_none() && !review)
        .filter_map(|(e, _)| match &e.payload {
            P::UserMessage { kickoff: true, .. } => None,
            // Already prefixed with who sent it, as the bot first read it.
            P::UserMessage { text, from: Some(_), .. } => Some(text.trim().to_string()),
            P::UserMessage { text, .. } => Some(format!("User: {}", text.trim())),
            P::AssistantText { text, .. } if crate::events::has_text(text) => Some(format!("You: {}", text.trim())),
            _ => None,
        })
        .collect()
}

/// Makes the folder, both files and the list entry. Both files start empty: the
/// bot is told its job in its first message and writes it down itself.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn create_bot(name: String, avatar: Option<BotAvatar>) -> Result<Bot, Fail> {
    // Dray Bot first, so a new bot taking its name is refused here rather
    // than Dray Bot being made beside it on the next read.
    if let Err(e) = ensure_dray_bot().await {
        eprintln!("[dray bot] {e:#}");
    }
    let _guard = BOTS_LOCK.lock().await;
    name_free(&read_list().await?, &name, None)?;
    make_bot(name, avatar, None).await
}

/// Told to the app whenever the list changes from outside it: `dray bot`.
pub const BOTS_CHANGED: &str = "bots_changed";

/// The shapes and hues a face can take, as the app's `SHAPES` and `HUES`
/// name them, for a bot made with no pick.
const SHAPES: [&str; 9] = ["round", "organic", "boxy", "capsule", "nub", "cloud", "hexagon", "sun", "triangle"];
const HUES: [f64; 8] = [25.0, 50.0, 80.0, 145.0, 185.0, 250.0, 295.0, 340.0];

/// A face from what `dray bot new` was given, the rest picked at random.
pub fn face(shape: Option<&str>, hue: Option<f64>) -> Result<BotAvatar> {
    let roll = uuid::Uuid::new_v4().as_u128();
    let shape = match shape.map(|s| s.trim().to_lowercase()) {
        Some(s) if SHAPES.contains(&s.as_str()) => s,
        Some(s) => anyhow::bail!("no shape {s:?} — try {}", SHAPES.join(", ")),
        None => SHAPES[(roll % SHAPES.len() as u128) as usize].to_string(),
    };
    let hue = match hue {
        Some(h) if (0.0..=360.0).contains(&h) => h,
        Some(h) => anyhow::bail!("hue {h} is out of range — give degrees, 0 to 360"),
        None => HUES[((roll >> 8) % HUES.len() as u128) as usize],
    };
    Ok(BotAvatar { shape, hue })
}

/// Bots are messaged by name, so two may not share one.
fn name_free(bots: &[Bot], name: &str, except: Option<&str>) -> Result<()> {
    let taken = bots.iter().any(|b| Some(b.id.as_str()) != except && same_name(&b.name, name));
    if taken {
        anyhow::bail!("there is already a bot named {:?}", name.trim());
    }
    Ok(())
}

fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// The bot `key` names: its id, else its name in any case.
pub async fn find_bot(key: &str) -> Result<Bot> {
    named(&list_bots().await?, key)
}

fn named(bots: &[Bot], key: &str) -> Result<Bot> {
    let key = key.trim();
    if let Some(bot) = bots.iter().find(|b| b.id == key) {
        return Ok(bot.clone());
    }
    match bots.iter().filter(|b| same_name(&b.name, key)).collect::<Vec<_>>().as_slice() {
        [one] => Ok((*one).clone()),
        [] => anyhow::bail!("no bot named {key:?} — `dray bot ls` lists them"),
        // Names made before they had to differ can still clash.
        several => anyhow::bail!(
            "{} bots are named {key:?} — name one by id: {}",
            several.len(),
            several.iter().map(|b| b.id.as_str()).collect::<Vec<_>>().join(", ")
        ),
    }
}

/// Renames a bot, and its open chat with it so `dray session ls` agrees.
pub async fn rename_bot(key: &str, name: &str, sink: &Sink) -> Result<Bot> {
    update_bot(key, name, None, sink).await
}

/// Edit in the sidebar: the New bot dialog's name and face, on a bot already made.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn edit_bot(id: String, name: String, avatar: BotAvatar, sink: Sink) -> Result<Bot, Fail> {
    let bot = update_bot(&id, &name, Some(avatar), &sink).await?;
    sink.emit(BOTS_CHANGED, ()).ok();
    Ok(bot)
}

/// Renames the bot `key` names and, given one, changes its face. A rename
/// reaches its open chat's title, and the bot itself before its next prompt.
async fn update_bot(key: &str, name: &str, avatar: Option<BotAvatar>, sink: &Sink) -> Result<Bot> {
    let name = name.trim().to_string();
    if name.is_empty() {
        anyhow::bail!("a bot needs a name");
    }
    let (bot, old) = {
        let _guard = BOTS_LOCK.lock().await;
        let mut bots = read_list().await?;
        let id = named(&bots, key)?.id;
        name_free(&bots, &name, Some(&id))?;
        let Some(bot) = bots.iter_mut().find(|b| b.id == id) else { unreachable!() };
        let old = std::mem::replace(&mut bot.name, name.clone());
        if let Some(avatar) = avatar {
            bot.avatar = Some(avatar);
        }
        let bot = bot.clone();
        save_list(&bots).await?;
        (bot, old)
    };
    if old != name {
        for item in chat_sessions(&bot.path).await.unwrap_or_default() {
            crate::rename_session(item.session_id, name.clone(), sink.clone()).await.ok();
        }
        let note = format!("The user renamed you from \"{old}\" to \"{name}\". Your name is {name} now.");
        note_bot(&bot.path, Note::Renamed, note);
    }
    Ok(bot)
}

/// Held by `dray bot send` from finding a bot has no chat until it has one.
/// One per bot, so an agent slow to start delays no other bot's messages.
pub fn first_chat_lock(bot_id: &str) -> std::sync::Arc<Mutex<()>> {
    static LOCKS: std::sync::Mutex<Vec<(String, std::sync::Arc<Mutex<()>>)>> = std::sync::Mutex::new(Vec::new());
    let mut locks = LOCKS.lock().unwrap();
    match locks.iter().find(|(id, _)| id == bot_id) {
        Some((_, lock)) => lock.clone(),
        None => {
            let lock = std::sync::Arc::new(Mutex::const_new(()));
            locks.push((bot_id.to_string(), lock.clone()));
            lock
        }
    }
}

/// The session a message to `bot` lands in: its chat's newest.
pub async fn chat_of(bot: &Bot) -> Option<SessionIndexItem> {
    chat_sessions(&bot.path).await.ok()?.pop()
}

/// The newest session ever run in `bot`'s folder, settled ones included: the
/// agent and model a new chat for it starts on.
pub async fn last_session_of(bot: &Bot) -> Option<SessionIndexItem> {
    let index = crate::store::read_index().await.ok()?;
    index
        .into_iter()
        .filter(|i| same_dir(&i.cwd, &bot.path) && i.routine_run.is_none())
        .max_by_key(|i| chrono::DateTime::parse_from_rfc3339(&i.created).ok())
}

/// What `dray bot ls` prints for a bot.
pub async fn summary(bot: Bot) -> dray_proto::BotSummary {
    let session_id = chat_of(&bot).await.map(|i| i.session_id);
    dray_proto::BotSummary {
        session_id,
        shape: bot.avatar.as_ref().map(|a| a.shape.clone()),
        hue: bot.avatar.as_ref().map(|a| a.hue),
        id: bot.id,
        name: bot.name,
        path: bot.path,
    }
}

/// The folder, both files and the list entry. Takes no lock: callers hold it.
async fn make_bot(name: String, avatar: Option<BotAvatar>, welcome: Option<String>) -> Result<Bot, Fail> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(anyhow::anyhow!("a bot needs a name").into());
    }
    let id = uuid::Uuid::now_v7().to_string();
    let dir = bots_dir().await?.join(&id);
    tokio::fs::create_dir_all(&dir).await.context("could not make the bot's folder")?;
    write_atomic(&dir.join(INSTRUCTIONS), "").await?;
    // Before the first commit, so the ignore rule is in it and the pointer never is.
    write_pointer(&dir).await;
    tokio::fs::create_dir_all(dir.join(MEMORY)).await.context("could not make the bot's memory folder")?;

    let bot = Bot {
        id,
        name,
        path: dir.to_string_lossy().into_owned(),
        created: chrono::Utc::now().to_rfc3339(),
        avatar,
        welcome,
        greeting: Vec::new(),
    };
    let mut bots = read_list().await?;
    bots.push(bot.clone());
    save_list(&bots).await?;
    // A bot without history still works, so this failing fails nothing.
    if let Err(e) = start_history(&bot).await {
        eprintln!("[bot history] {e:#}");
    }
    Ok(bot)
}

/// Drops the list entry and the folder. The bot's sessions stay in the index,
/// as any session does once its project is gone; delete those on their own.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_bot(id: String, sink: Sink) -> Result<(), Fail> {
    // A first message opening the bot's chat holds this until the chat is on
    // the index, so the settle below sees it rather than leaving it open on a
    // folder that is about to go. Taken before `BOTS_LOCK`, as the send does.
    let first = first_chat_lock(&id);
    let _first = first.lock().await;
    let _guard = BOTS_LOCK.lock().await;
    let mut bots = read_list().await?;
    let Some(at) = bots.iter().position(|b| b.id == id) else {
        return Ok(());
    };
    // Every chat still open in its folder is settled first, here rather than
    // by the caller: the frontend holds one side of the index and, with the
    // settled list up, cannot see the open chat. Settling stops it and its
    // hidden children; once the folder is gone nothing marks it a bot's.
    let open: Vec<String> = crate::store::read_index()
        .await?
        .into_iter()
        .filter(|s| !s.archived && Path::new(&s.cwd) == Path::new(&bots[at].path))
        .map(|s| s.session_id)
        .collect();
    for session_id in open {
        crate::set_session_flags(&session_id, Some(true), None, None, None, sink.clone()).await?;
    }
    let bot = bots.remove(at);
    save_list(&bots).await?;
    if let Err(e) = crate::routines::remove_bot(&bot.id).await {
        eprintln!("[routines] {e:#}");
    }
    // Only a folder this module made: a list entry edited by hand must not
    // aim the removal anywhere else.
    if Path::new(&bot.path).starts_with(bots_dir().await?) {
        tokio::fs::remove_dir_all(&bot.path).await.ok();
    }
    Ok(())
}

/// A bot chat's inbox row: its last reply, and the replies since the reader
/// last wrote.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "events.ts")]
pub struct BotPreview {
    pub text: Option<String>,
    pub replies: u32,
}

/// Each bot chat's inbox row, keyed by session.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn bot_previews(
    session_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, BotPreview>, Fail> {
    let mut previews = std::collections::HashMap::new();
    for id in session_ids {
        let (text, replies) = crate::store::last_reply(&id).await?;
        previews.insert(id, BotPreview { text, replies });
    }
    Ok(previews)
}

/// How far back [`bot_task_reply`] reads a bot's chat: a task with no report
/// anywhere must not read a very long chat whole.
const REPLY_SCAN: u64 = 32 * 1024 * 1024;

/// How many of a task's reports [`bot_task_reply`] looks past for one the bot
/// answered.
const REPORTS_TRIED: usize = 10;

/// What a bot last told the reader about one of its tasks: its reply to the
/// task's newest report it answered. A report it let pass — answered by
/// messaging the task, or a turn that failed — is looked past, since its reply
/// to the one before is still its latest word on the task. `None` where there
/// is none to show, and the Waiting on you row opens the task instead.
///
/// Two passes, so a long chat costs a byte search: back from the end, each
/// chunk searched for the task's id and only a line holding it parsed, to a
/// report; then forward from there, parsing to the reply's end. Read where
/// asked rather than recorded as it happens, since a record would still need
/// this walk for every report logged before it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn bot_task_reply(session_id: String, task_id: String) -> Result<Option<String>, Fail> {
    let Some((mut log, len)) = crate::store::open_log(&session_id).await? else { return Ok(None) };
    Ok(task_reply(&mut log, len, &task_id, 256 * 1024).await?)
}

/// [`bot_task_reply`] over a log `len` bytes long, read `chunk` bytes at a time.
async fn task_reply(
    log: &mut (impl tokio::io::AsyncRead + tokio::io::AsyncSeek + Unpin),
    len: u64,
    task_id: &str,
    chunk: u64,
) -> Result<Option<String>> {
    let finder = memchr::memmem::FinderRev::new(task_id.as_bytes());
    let mut before = None;
    for _ in 0..REPORTS_TRIED {
        let report = crate::store::scan_back(log, len, before, REPLY_SCAN, chunk, |chunk, at| {
            finder.rfind_iter(chunk).find_map(|hit| {
                let start = memchr::memrchr(b'\n', &chunk[..hit]).map_or(0, |i| i + 1);
                let end = memchr::memchr(b'\n', &chunk[hit..]).map_or(chunk.len(), |i| hit + i);
                let report = log_line(&chunk[start..end]).is_some_and(|l| l.report_from() == Some(task_id));
                report.then_some((at + start as u64, at + end as u64))
            })
        })
        .await?;
        let Some((start, end)) = report else { return Ok(None) };
        let mut texts = Vec::new();
        crate::store::scan_forward(log, end, chunk as usize, |line| reply_goes_on(line, &mut texts)).await?;
        if !texts.is_empty() {
            return Ok(Some(texts.join("\n\n")));
        }
        before = Some(start);
    }
    Ok(None)
}

/// The kinds of line [`bot_task_reply`] reads, parsed no further.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ReplyPayload {
    UserMessage {
        text: String,
        from: Option<ReplySender>,
    },
    AssistantText {
        text: String,
    },
    TurnCompleted {
        status: String,
        #[serde(rename = "finalText")]
        final_text: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplySender {
    session_id: String,
    bot_id: Option<String>,
}

impl ReplyPayload {
    /// The task a report came from: a relayed message from a session, not a
    /// bot, and not a stall nudge, which is Dray's (`nudge_bot`) and gets no reply.
    fn report_from(&self) -> Option<&str> {
        let Self::UserMessage { text, from: Some(from) } = self else { return None };
        // Past the sender line `attribute` writes, which ends in a blank line.
        let said = text.split_once("]\n\n").map_or(text.as_str(), |(_, rest)| rest);
        (from.bot_id.is_none() && !said.starts_with("Stall nudge:")).then_some(from.session_id.as_str())
    }
}

/// A main-thread line of a kind [`ReplyPayload`] names; `None` for any other,
/// tested by needle before parsing.
fn log_line(line: &[u8]) -> Option<ReplyPayload> {
    use memchr::memmem::Finder;
    use std::sync::LazyLock;
    static NEEDLES: LazyLock<[Finder; 3]> = LazyLock::new(|| {
        [r#""type":"user_message""#, r#""type":"assistant_text""#, r#""type":"turn_completed""#]
            .map(|n| Finder::new(n.as_bytes()).into_owned())
    });
    #[derive(Deserialize)]
    struct Line {
        subagent: Option<serde::de::IgnoredAny>,
        payload: ReplyPayload,
    }
    if !NEEDLES.iter().any(|n| n.find(line).is_some()) {
        return None;
    }
    serde_json::from_slice::<Line>(line).ok().filter(|l| l.subagent.is_none()).map(|l| l.payload)
}

/// Takes the bot's text after a report until its turn ends or the next message
/// comes in. Reports landing back to back share the text after them, since a
/// bot busy when they land answers them together; anything else coming in ends
/// the reply. A failed turn's error sentence, which the harness also sends as
/// text, is no reply.
fn reply_goes_on(line: &[u8], texts: &mut Vec<String>) -> bool {
    match log_line(line) {
        Some(ReplyPayload::AssistantText { text }) => {
            if crate::events::has_text(&text) {
                texts.push(text);
            }
            true
        }
        // A reply ends with its turn.
        Some(ReplyPayload::TurnCompleted { status, final_text }) => {
            if status == "error" && final_text.is_some() && texts.last() == final_text.as_ref() {
                texts.pop();
            }
            false
        }
        Some(message) => texts.is_empty() && message.report_from().is_some(),
        None => true,
    }
}

/// Dray's own prompts on their way into a bot's chat, as (session, text): a
/// kickoff, or a review (#973). The transcript draws no bubble for either.
/// Read where the prompt's event is built: threading a flag through
/// `send_msg`'s twenty parameters for two callers would touch every other one.
/// Keyed on the text too, so a message the reader sends meanwhile is never
/// taken for one.
static DRAY_PROMPTS: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

pub fn mark_dray_prompt(session_id: &str, prompt: &str) {
    DRAY_PROMPTS.lock().unwrap().push((session_id.to_string(), prompt.to_string()));
}

/// Whether `prompt`, now being logged in `session_id`, is Dray's own, and forgets it.
pub fn take_dray_prompt(session_id: &str, prompt: &str) -> bool {
    let mut marks = DRAY_PROMPTS.lock().unwrap();
    let at = marks.iter().position(|(s, p)| s == session_id && p == prompt);
    at.map(|i| marks.remove(i)).is_some()
}

/// Opens a bot's chat with the bot speaking first: a prompt the reader never
/// sees asks it to introduce itself, so the chat starts on its greeting.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn start_bot(
    id: String,
    harness: Harness,
    model: ModelId,
    effort: Option<Effort>,
    permission_mode: ApprovalPolicy,
    fast: bool,
    sink: Sink,
) -> Result<SessionIndexItem, Fail> {
    if !harness.names_a_cli() {
        return Err(anyhow::anyhow!("invalid harness").into());
    }
    let bot = list_bots()
        .await?
        .into_iter()
        .find(|b| b.id == id)
        .ok_or_else(|| anyhow::anyhow!("no bot {id}"))?;
    let session_id = uuid::Uuid::now_v7().to_string();
    let user = user_name().await;
    let prompt = kickoff_prompt(&bot, user.as_deref()).await;
    mark_dray_prompt(&session_id, &prompt);
    if user.is_none() {
        NAME_ASKS.lock().unwrap().push(session_id.clone());
    }
    let sent = manager()
        .send_msg(
            &session_id, &prompt, &[], &[], harness, model, effort, permission_mode, fast,
            &bot.path, None, false, None, None, true, None, false, Some(&bot.name), None, None, &sink,
        )
        .await;
    // A send that failed before logging the prompt left the mark behind.
    take_dray_prompt(&session_id, &prompt);
    let item = sent?
        .snapshot
        .map(|s| s.index_item)
        .ok_or_else(|| anyhow::anyhow!("the bot's chat started but returned no index entry"))?;
    sink.emit(crate::orchestration::SESSION_CREATED, &item).ok();
    Ok(item)
}

/// Kickoff chats owed [`ASK_NAME`] once the greeting's turn ends. Dray asks
/// rather than the bot, so the question is always a message of its own, which
/// one model turn cannot promise; the kickoff tells the bot it is coming.
static NAME_ASKS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Whether `session_id`'s turn that just ended was a kickoff owing the
/// question for the user's name. Taken once, asked or not.
pub fn take_name_ask(session_id: &str) -> bool {
    let mut asks = NAME_ASKS.lock().unwrap();
    let at = asks.iter().position(|id| id == session_id);
    at.map(|i| asks.remove(i)).is_some()
}

/// What the bot is asked before anyone has written to it. The projects ride
/// along so its guess at a job has something to go on.
async fn kickoff_prompt(bot: &Bot, user: Option<&str>) -> String {
    let projects: Vec<String> = crate::projects::list_projects()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| Path::new(&p.path).file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    let projects = if projects.is_empty() { "none yet".to_string() } else { projects.join(", ") };
    let (greet, unnamed) = match user {
        Some(user) => (format!("Greet the user as {user}"), ""),
        None => (
            "Greet the user without a name".to_string(),
            " Never guess their name, from git or anywhere: Dray asks what to call them in a message of its own right after yours, so don't ask that either.",
        ),
    };
    fill(KICKOFF_PROMPT, &[("name", &bot.name), ("projects", &projects), ("greet", &greet), ("unnamed", unnamed)])
}

/// Caller holds `BOTS_LOCK`: the file is rewritten whole.
async fn save_list(bots: &[Bot]) -> Result<()> {
    write_atomic(&list_path().await?, serde_json::to_string_pretty(bots)?).await
}

async fn read_file(path: &Path) -> String {
    tokio::fs::read_to_string(path).await.unwrap_or_default()
}

/// The bot whose session runs in `cwd`, if any.
pub async fn bot_at(cwd: &str) -> Option<Bot> {
    let bots = read_list().await.ok()?;
    bots.into_iter().find(|b| same_dir(&b.path, cwd))
}

/// The bot whose folder is `path` or holds it. Inside counts: git finds the
/// bot's history from any folder under it.
pub async fn bot_holding(path: &str) -> Option<Bot> {
    let bots = read_list().await.ok()?;
    bots.into_iter().find(|b| holds(&b.path, path))
}

/// The session whose browser a `dray browser` step from `session_id` drives.
/// A bot chat is every session in its folder, and an agent switch starts a
/// newer one, so its pages live on the oldest (#878); `botBrowser` in the
/// frontend picks the same. Anything else, a bot's tasks included, its own.
pub async fn browser_owner(session_id: &str) -> String {
    let Some(item) = crate::store::get_session_index_item(session_id).await.ok().flatten() else {
        return session_id.to_string();
    };
    if bot_at(&item.cwd).await.is_none() {
        return session_id.to_string();
    }
    match chat_sessions(&item.cwd).await.ok().and_then(|c| c.into_iter().next()) {
        Some(oldest) => oldest.session_id,
        None => session_id.to_string(),
    }
}

/// Component-wise, so `bots/bb` is not inside `bots/b`.
fn holds(dir: &str, path: &str) -> bool {
    Path::new(path).starts_with(dir)
}

fn same_dir(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
}

/// Whether two sessions' `cwd`s are one folder, as a bot's chat and its runs share.
pub fn same_folder(a: &str, b: &str) -> bool {
    same_dir(a, b)
}

/// Whether `item` is a bot's session, or anything one started, at any depth.
///
/// Everything under a bot runs hidden and reports back after every turn, and a
/// grandchild belongs to that arrangement as much as a child does. A bot on
/// another machine is in no index here, so its tree starts at the task it
/// started here, the one this server keeps reports for.
pub async fn in_bot_tree(item: &SessionIndexItem) -> bool {
    if bot_chat_of(item).await.is_some() {
        return true;
    }
    let owed = crate::remote_reports::owed_tasks().await;
    !owed.is_empty() && crate::store::reaches(item, |i| owed.contains(&i.session_id)).await.unwrap_or(false)
}

/// The bot chat session `item` is, or the one it descends from.
pub(crate) async fn bot_chat_of(item: &SessionIndexItem) -> Option<SessionIndexItem> {
    let bots = read_list().await.ok()?;
    if bots.is_empty() {
        return None;
    }
    let mut at = Some(item.clone());
    // Bounded: an index that points a session at its own ancestor must cost a
    // wrong answer, never a hung turn.
    for _ in 0..8 {
        let item = at?;
        if bots.iter().any(|b| same_dir(&b.path, &item.cwd)) {
            return Some(item);
        }
        at = crate::store::tree_parent(&item).await.ok().flatten();
    }
    None
}

/// Whether `item` is a bot's task, whose sub-tasks outlive it: settling or
/// deleting it leaves them running, adopted by the nearest live ancestor, where
/// any other session's hidden children go with it. Only under a bot here: one
/// on another machine leaves no live session here to adopt them.
pub async fn keeps_children(item: &SessionIndexItem) -> bool {
    bot_at(&item.cwd).await.is_none() && bot_chat_of(item).await.is_some()
}

/// `base` with the bot's own block added where `cwd` is a bot's folder, or the
/// task block where `session_id` is a task reporting back to a bot's tree.
///
/// Every harness's system-prompt slot goes through here, so a bot is the same
/// bot on each. Read at spawn: a session already running keeps the text it
/// started with, which is fine for the bot's own edits — it made them, so it
/// knows — and is why Settings says an edit lands at the bot's next start.
/// The instructions are not in it: the agent loads `AGENTS.md` itself, and
/// injecting them too would put them in its context twice.
pub async fn system_prompt(base: &str, session_id: &str, cwd: &str, harness: Harness) -> String {
    let bots = read_list().await.unwrap_or_default();
    let Some(bot) = bots.iter().find(|b| same_dir(&b.path, cwd)) else {
        return if reports_to_parent(session_id).await {
            format!("{base}\n\n{}", TASK_PROMPT.trim_end())
        } else {
            base.to_string()
        };
    };
    let others: Vec<&str> = bots.iter().filter(|b| b.id != bot.id).map(|b| b.name.as_str()).collect();
    prepare_folder(bot).await;
    let instructions = read_file(&Path::new(&bot.path).join(INSTRUCTIONS)).await;
    let user = user_name().await;
    format!("{base}\n\n{}", bot_block(bot, &others, &instructions, user.as_deref(), harness))
}

/// Where a bot sends long work that changes no repo. Measured on a Mac: a
/// background subagent outlives the turn and wakes the parent with its result
/// on Claude Code and grok. Codex keeps one running but never wakes the
/// parent, fx holds the turn until it ends, and pi has none, so those start a
/// task. The tool is named because Codex reached for a background shell until
/// told which tool to use.
fn long_work(harness: Harness) -> &'static str {
    match harness {
        Harness::ClaudeCode => {
            "Other work that takes more than a couple of minutes or has several steps, such as setting up a machine, research, checking logs or taking a snapshot, goes to a background subagent: the Agent tool with `run_in_background: true`. Your turn then ends at once, and its result comes back to you on its own. Pass on what matters when it reports."
        }
        Harness::Grok => {
            "Other work that takes more than a couple of minutes or has several steps, such as setting up a machine, research, checking logs or taking a snapshot, goes to a background subagent: `spawn_subagent` with `background: true`, and no waiting on it. Your turn then ends at once, and its result comes back to you on its own. Pass on what matters when it reports."
        }
        _ => {
            "So does other work that takes more than a couple of minutes or has several steps, such as setting up a machine, research, checking logs or taking a snapshot: start it with `--no-worktree`, below."
        }
    }
}

/// Readies the folder of the bot whose session runs in `cwd`, where it is a
/// bot's. For a resume that sends no prompt, grok's and fx's, which would
/// otherwise skip [`system_prompt`] and the move of an old `INSTRUCTIONS.md`.
pub async fn prepare(cwd: &str) {
    if let Some(bot) = bot_at(cwd).await {
        prepare_folder(&bot).await;
    }
}

/// What every spawn of a bot needs on disk before its agent reads the folder.
async fn prepare_folder(bot: &Bot) {
    let dir = Path::new(&bot.path);
    // Ahead of the history, so a folder getting its first commit here never
    // commits the pointer.
    write_pointer(dir).await;
    // Every bot's spawn passes here, so a bot made before there was history
    // gets it on first use, and its prompt is true from its first turn.
    if let Err(e) = start_history(bot).await {
        eprintln!("[bot history] {e:#}");
    }
    if let Err(e) = move_legacy_instructions(bot).await {
        eprintln!("[bot instructions] {e:#}");
    }
    // A bot made before memory was a folder has none, and the prompt sends it
    // straight to one. Its old `MEMORY.md` is left alone: bots had no users yet.
    tokio::fs::create_dir_all(dir.join(MEMORY)).await.ok();
    learn::ensure_skills(dir).await;
}

/// Writes the `CLAUDE.md` that imports the instructions for Claude Code, and
/// the ignore rule that keeps it out of grok's rules and the bot's history. A
/// `CLAUDE.md` already there is left alone.
async fn write_pointer(dir: &Path) {
    let ignore = dir.join(".gitignore");
    let ignored = read_file(&ignore).await;
    let rule = format!("/{CLAUDE_POINTER}");
    if !ignored.lines().any(|l| l.trim() == rule || l.trim() == CLAUDE_POINTER) {
        let sep = if ignored.is_empty() || ignored.ends_with('\n') { "" } else { "\n" };
        if let Err(e) = write_atomic(&ignore, &format!("{ignored}{sep}{rule}\n")).await {
            eprintln!("[bot instructions] {e:#}");
        }
    }
    let pointer = dir.join(CLAUDE_POINTER);
    if tokio::fs::symlink_metadata(&pointer).await.is_err() {
        if let Err(e) = write_atomic(&pointer, POINTER_TEXT).await {
            eprintln!("[bot instructions] {e:#}");
        }
    }
}

/// Moves a bot's `INSTRUCTIONS.md` to `AGENTS.md` (#1118) and commits the
/// move on its own, with the ignore rule [`write_pointer`] added, so the turn
/// that follows reads no rule as removed and re-added. An `AGENTS.md` the bot
/// already has keeps its text, with the old file's appended below.
async fn move_legacy_instructions(bot: &Bot) -> Result<()> {
    let dir = Path::new(&bot.path);
    let legacy = dir.join(LEGACY_INSTRUCTIONS);
    if !legacy.exists() {
        return Ok(());
    }
    let _guard = HISTORY_LOCK.lock().await;
    let old = tokio::fs::read_to_string(&legacy).await.context("could not read INSTRUCTIONS.md")?;
    let now = read_file(&dir.join(INSTRUCTIONS)).await;
    // Ending on the old text whole, as a move writes it, means one cut off
    // before the removal; appending again would repeat every rule. Matched
    // as that block, never a substring, which a longer rule can hold.
    let (tail, block) = (now.trim_end(), old.trim_end());
    let copied = tail == block || tail.ends_with(&format!("\n\n{block}"));
    let merged = if now.trim().is_empty() {
        old
    } else if old.trim().is_empty() || copied {
        now
    } else {
        format!("{}\n\n{old}", now.trim_end())
    };
    write_atomic(&dir.join(INSTRUCTIONS), &merged).await?;
    tokio::fs::remove_file(&legacy).await.context("could not remove INSTRUCTIONS.md")?;
    // A grok or fx chat resumes on the prompt it started with, which still
    // names the old file, so the bot is told whatever its agent.
    note_bot(
        &bot.path,
        Note::Moved,
        format!("Your instructions moved from `{LEGACY_INSTRUCTIONS}` to `{INSTRUCTIONS}`, which your agent loads on its own at the start of every session. Edit `{INSTRUCTIONS}` from now on; `{LEGACY_INSTRUCTIONS}` is gone."),
    );
    if !dir.join(".git").exists() {
        return Ok(());
    }
    // A pathspec naming a file neither on disk nor tracked fails the add.
    let mut paths = Vec::new();
    for path in [INSTRUCTIONS, ".gitignore", LEGACY_INSTRUCTIONS] {
        if dir.join(path).exists() || !git(dir, &["ls-files", "--", path]).await?.trim().is_empty() {
            paths.push(path);
        }
    }
    commit_paths(bot, "Move INSTRUCTIONS.md to AGENTS.md", &paths).await
}

/// The bot's own block, `{name}`, `{path}`, `{others}` and `{instructions}`
/// (a note on the file, never its text) filled at spawn.
const BOT_PROMPT: &str = include_str!("bots/bot_prompt.md");
/// Told to every task under a bot. Unaware its reply is relayed, a task also
/// sent it with `dray session send`, and the bot read every report twice.
const TASK_PROMPT: &str = include_str!("bots/task_prompt.md");
/// The bot's first turn, before anyone has written to it.
const KICKOFF_PROMPT: &str = include_str!("bots/kickoff_prompt.md");

/// Fills `{key}` placeholders in one pass, so a value spelling a placeholder —
/// the bot's own files can say anything — is never filled in turn. An unknown
/// `{…}` is left as written.
fn fill(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let hit = after.find('}').and_then(|end| {
            vars.iter().find(|(key, _)| *key == &after[..end]).map(|(_, value)| (*value, end))
        });
        match hit {
            Some((value, end)) => {
                out.push_str(value);
                rest = &after[end + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.trim_end().to_string()
}

/// Whether Dray relays this session's turns to its parent: the check
/// [`report_to_parent`](crate::orchestration::report_to_parent) makes, read
/// off the index entry `send_msg` writes before the spawn.
async fn reports_to_parent(session_id: &str) -> bool {
    match crate::store::get_session_index_item(session_id).await {
        Ok(Some(item)) => {
            item.parent_session_id.is_some() && in_bot_tree(&item).await
        }
        _ => false,
    }
}

/// One bot's folder at a time: a first-use init and a turn's commit must not
/// both run `git add` in it.
static HISTORY_LOCK: Mutex<()> = Mutex::const_new(());

/// Makes the bot's folder a git repository with a first commit, where it is
/// not one yet. `.git` is looked for rather than asked of git, which would
/// answer for a repository the home happens to sit inside.
async fn start_history(bot: &Bot) -> Result<()> {
    let _guard = HISTORY_LOCK.lock().await;
    let dir = Path::new(&bot.path);
    if dir.join(".git").exists() {
        return Ok(());
    }
    git(dir, &["init", "-q", "-b", "main"]).await?;
    commit_all(bot, Some("Start history")).await.map(drop)
}

/// Commits what a turn of the bot at `cwd` changed in its folder, where `cwd`
/// is a bot's, and reads back the lessons in it. Dray does it rather than the
/// bot, which could forget. `None` where `cwd` is no bot's.
pub async fn commit_turn(cwd: &str, notes: learn::TurnNotes, sink: &Sink) -> Option<learn::Turn> {
    let bot = bot_at(cwd).await?;
    let turn = commit_bot_turn(&bot, notes).await;
    if let Some(commit) = &turn.commit {
        learn_user_name(&bot, commit, sink).await;
    }
    Some(turn)
}

async fn commit_bot_turn(bot: &Bot, notes: learn::TurnNotes) -> learn::Turn {
    let mut turn = learn::Turn { notes, ..Default::default() };
    if let Err(e) = start_history(bot).await {
        eprintln!("[bot history] {e:#}");
        return turn;
    }
    let dir = Path::new(&bot.path);
    let _guard = HISTORY_LOCK.lock().await;
    if turn.notes.reviewing() {
        match learn::keep_rules(dir).await {
            Ok(true) => eprintln!("[bot learn] a review took a rule away from {}; put back", bot.name),
            Ok(false) => {}
            Err(e) => eprintln!("[bot learn] {e:#}"),
        }
    }
    turn.commit = match commit_all(bot, None).await {
        Ok(commit) => commit,
        Err(e) => {
            eprintln!("[bot history] {e:#}");
            None
        }
    };
    if let Some(commit) = &turn.commit {
        match learn::read_commit(dir, commit).await {
            Ok((files, oversize)) => (turn.files, turn.oversize) = (files, oversize),
            Err(e) => eprintln!("[bot learn] {e:#}"),
        }
    }
    turn
}

/// Stages everything and commits it, where anything changed, answering the
/// commit. `None` names the files changed instead.
async fn commit_all(bot: &Bot, message: Option<&str>) -> Result<Option<String>> {
    let dir = Path::new(&bot.path);
    git(dir, &["add", "-A"]).await?;
    let changed = git(dir, &["diff", "--cached", "--name-only", "-z"]).await?;
    let files: Vec<&str> = changed.split('\0').filter(|f| !f.is_empty()).collect();
    if files.is_empty() {
        return Ok(None);
    }
    let message = message.map_or_else(|| turn_message(&files), str::to_string);
    commit_as(bot, &["commit", "-q", "-m", &message]).await?;
    Ok(Some(git(dir, &["rev-parse", "HEAD"]).await?.trim().to_string()))
}

/// Commits `paths` alone, staged first, leaving anything else in the folder
/// for the turn's own commit.
async fn commit_paths(bot: &Bot, message: &str, paths: &[&str]) -> Result<()> {
    let mut add = vec!["add", "-A", "--"];
    add.extend_from_slice(paths);
    git(Path::new(&bot.path), &add).await?;
    let mut commit = vec!["commit", "-q", "-m", message, "--"];
    commit.extend_from_slice(paths);
    commit_as(bot, &commit).await
}

/// Runs a commit as the bot: its own name on every one, so its history needs
/// no global identity and reads as its own. Given each time rather than
/// written to the repo's config once, which a setup cut off after `init`
/// would skip.
async fn commit_as(bot: &Bot, args: &[&str]) -> Result<()> {
    let name = format!("user.name={}", bot.name);
    let email = format!("user.email={}@bots.dray.local", bot.id);
    let mut all = vec!["-c", name.as_str(), "-c", email.as_str()];
    all.extend_from_slice(args);
    git(Path::new(&bot.path), &all).await.map(drop)
}

/// The two halves of one file of a "Learned" row, for View diff.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn bot_learned_diff(session_id: String, commit: String, path: String) -> Result<learn::LearnedDiff, Fail> {
    let bot = bot_of_session(&session_id).await?;
    Ok(learn::diff(&bot, &commit, &path).await?)
}

/// Undo on a "Learned" row: reverts that one file of the commit and says so in
/// the chat, where the row reads it back as undone.
///
/// The bot is told too, hidden like a review: a running child read its
/// instructions at spawn and still follows the rule the file no longer holds.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn bot_undo_learned(session_id: String, commit: String, path: String, sink: Sink) -> Result<(), Fail> {
    let bot = bot_of_session(&session_id).await?;
    let live = learn::undo(&bot, &commit, &path).await?;
    let item = crate::store::get_session_index_item(&session_id).await?.context("no such session")?;
    let told = learn::undone_prompt(&live, &commit);
    let payload = crate::events::AgentEventPayload::LearnedUndone { commit, path };
    manager().log_event(&session_id, item.harness, payload, &sink).await?;
    crate::orchestration::send_review(session_id, told, sink).await?;
    Ok(())
}

async fn bot_of_session(session_id: &str) -> Result<Bot> {
    let item = crate::store::get_session_index_item(session_id).await?.context("no such session")?;
    bot_at(&item.cwd).await.context("that session is no bot's chat")
}

fn turn_message(files: &[&str]) -> String {
    let shown = files.iter().take(3).copied().collect::<Vec<_>>().join(", ");
    match files.len() {
        n if n > 3 => format!("Update {shown} and {} more", n - 3),
        _ => format!("Update {shown}"),
    }
}

/// Runs git in a bot's folder, cut off from the reader's global setup: their
/// hooks would run against the notes and could fail or hang a commit, their
/// ignore rules could leave the bot's notes untracked, and a signing key would
/// prompt on every turn.
async fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let out = tokio::process::Command::new("git")
        .args(["-c", "core.hooksPath=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .await
        .context("could not run git")?;
    if !out.status.success() {
        anyhow::bail!("git: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// What the prompt says about the instructions file, never its text: the
/// agent loads that itself. Something only where the bot must act on it.
fn instructions_note(instructions: &str) -> String {
    let size = instructions.chars().count();
    if instructions.trim().is_empty() {
        format!("`{INSTRUCTIONS}` is empty: your job is whatever the user tells you first, so write it down there.")
    } else if size > FILE_CAP {
        format!("`{INSTRUCTIONS}` is {size} characters, over its {FILE_CAP} cap: ask the user which rules to cut or merge.")
    } else {
        String::new()
    }
}

fn bot_block(bot: &Bot, others: &[&str], instructions: &str, user: Option<&str>, harness: Harness) -> String {
    let user = match user {
        Some(user) => format!(
            "Call the user {user}. If they ask to be called something else, write just that name to `{USER_FILE}` in your folder and use it from then on; Dray shares it with the other bots."
        ),
        None => format!(
            "You don't know the user's name yet. Never guess it, from git, the computer's account or anywhere else. Your chat opens by asking what to call them; when they say, write just that name to `{USER_FILE}` in your folder and use it from then on. Dray shares it with the other bots."
        ),
    };
    let others = match others {
        [] => "There are no other bots yet.".to_string(),
        names => format!("The other bots now: {}.", names.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(", ")),
    };
    fill(
        BOT_PROMPT,
        &[
            ("name", &bot.name),
            ("path", &bot.path),
            ("instructions", &instructions_note(instructions)),
            ("others", &others),
            ("user", &user),
            ("long_work", long_work(harness)),
        ],
    )
}

/// A closing tag inside the text would end the block early and let the rest
/// read as prompt — so it is broken up, as OpenBot does for its own file.
fn escape(text: &str, tag: &str) -> String {
    text.replace(&format!("</{tag}>"), &format!("<\\/{tag}>"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot() -> Bot {
        Bot { id: "b".into(), name: "Ops".into(), path: "/h/bots/b".into(), created: String::new(), avatar: None, welcome: None, greeting: Vec::new() }
    }

    /// The real file passes over a log in memory, at chunk sizes that cut
    /// lines in two, so a report straddling a chunk is still found and read.
    #[tokio::test]
    async fn task_reply_reads_the_bot_text_after_each_report() {
        let report = |id: &str, said: &str| {
            let text = format!("[message from the Dray session \"{id}\" ({id})]\n\n{said}");
            serde_json::json!({ "type": "user_message", "text": text, "from": { "sessionId": id, "title": id } })
        };
        let user = |text: &str| serde_json::json!({ "type": "user_message", "text": text, "from": null });
        let said = |text: &str| serde_json::json!({ "type": "assistant_text", "block": { "messageId": "m", "index": 0 }, "text": text });
        let mut payloads = vec![
            report("a", "Old report"),
            said("Old reply"),
            report("a", "Should I keep it?"),
            report("b", "Done"),
            said("A asks whether to keep it."),
            said("B is done."),
            report("a", "Stall nudge: this task has sat idle"),
            said("ignored"),
            report("c", "Which port?"),
            user("thanks"),
            said("You're welcome."),
            report("d", "Pick one?"),
            said("D asks you to pick one."),
            // Answered by messaging the task, so nothing in the chat.
            report("d", "Going with the first."),
            report("c", "Which port, again?"),
            said("API Error: Can't reach the API server"),
            serde_json::json!({ "type": "turn_completed", "status": "error", "finalText": "API Error: Can't reach the API server" }),
            report("f", "First"),
            said("F reply"),
        ];
        // More unanswered reports than `bot_task_reply` looks past.
        for _ in 0..REPORTS_TRIED {
            payloads.extend([report("f", "Again"), user("ok")]);
        }
        // Serialized the way the log writes them, so the needle tests are pinned too.
        let mut lines: Vec<String> = payloads
            .into_iter()
            .map(|payload| serde_json::json!({ "id": "x", "subagent": null, "payload": payload }).to_string())
            .collect();
        lines.insert(6, serde_json::json!({ "subagent": { "id": "s" }, "payload": said("a subagent's word") }).to_string());
        let log = lines.join("\n") + "\n";

        let both = Some("A asks whether to keep it.\n\nB is done.".to_string());
        let want = [
            // An error sentence is no reply, and the reader's message closed c's first report.
            ("a", both.clone()),
            ("b", both),
            ("c", None),
            // d's newest report was let pass, so its reply to the one before stands.
            ("d", Some("D asks you to pick one.".to_string())),
            ("e", None),
            // Looking past stops after REPORTS_TRIED reports.
            ("f", None),
        ];
        for chunk in [61, 300, 1 << 20] {
            for (task, reply) in &want {
                let mut file = std::io::Cursor::new(log.as_bytes());
                let got = task_reply(&mut file, log.len() as u64, task, chunk).await.unwrap();
                assert_eq!(&got, reply, "task {task}, chunk {chunk}");
            }
        }
    }

    #[test]
    fn block_points_at_the_instructions_and_memory_without_their_text() {
        let block = bot_block(&bot(), &["Research"], "Watch CI.", None, Harness::ClaudeCode);
        assert!(!block.contains("Watch CI."), "the agent loads AGENTS.md itself");
        assert!(block.contains(&format!("`{INSTRUCTIONS}`")));
        assert!(block.contains("/h/bots/b"));
        assert!(block.contains(&format!("`{MEMORY}/`")));
        assert!(block.contains("YYYY-MM-DD-short-title.md"));
        assert!(block.contains("never ask it to report back"));
        assert!(block.contains("dray session settle <id> --delete-worktree"));
        assert!(block.contains("The other bots now: \"Research\"."));
        assert!(bot_block(&bot(), &[], "", None, Harness::ClaudeCode).contains("There are no other bots yet."));
    }

    /// Claude Code and grok are told to use a background subagent, naming the
    /// tool; Codex, fx and pi have none that wakes the bot, so their long work
    /// goes to a task.
    #[test]
    fn long_work_goes_where_the_harness_can_take_it() {
        let claude = bot_block(&bot(), &[], "", None, Harness::ClaudeCode);
        assert!(claude.contains("the Agent tool with `run_in_background: true`"));
        let grok = bot_block(&bot(), &[], "", None, Harness::Grok);
        assert!(grok.contains("`spawn_subagent` with `background: true`"));
        for harness in [Harness::Pi, Harness::Codex, Harness::Fx] {
            let block = bot_block(&bot(), &[], "", None, harness);
            assert!(!block.contains("subagent"), "{harness:?}");
            assert!(block.contains("start it with `--no-worktree`"), "{harness:?}");
        }
        assert!(!claude.contains("{long_work}"));
    }

    fn named_bot(id: &str, name: &str) -> Bot {
        Bot { id: id.into(), name: name.into(), ..bot() }
    }

    #[test]
    fn a_bot_is_found_by_id_or_by_name_in_any_case() {
        let bots = [named_bot("1", "Ops"), named_bot("2", "Research"), named_bot("3", "twin"), named_bot("4", "Twin")];
        assert_eq!(named(&bots, "ops").unwrap().id, "1");
        assert_eq!(named(&bots, " Research ").unwrap().id, "2");
        assert_eq!(named(&bots, "2").unwrap().id, "2");
        assert!(named(&bots, "nobody").unwrap_err().to_string().contains("dray bot ls"));
        assert!(named(&bots, "TWIN").unwrap_err().to_string().contains("3, 4"));
    }

    #[test]
    fn two_bots_cannot_share_a_name() {
        let bots = [named_bot("1", "Ops")];
        assert!(name_free(&bots, " ops", None).is_err());
        assert!(name_free(&bots, "OPS", Some("1")).is_ok(), "renaming a bot to its own name");
        assert!(name_free(&bots, "Research", None).is_ok());
    }

    #[test]
    fn a_face_takes_what_it_is_given_and_picks_the_rest() {
        let face1 = face(Some("Sun"), Some(145.0)).unwrap();
        assert_eq!((face1.shape.as_str(), face1.hue), ("sun", 145.0));
        let picked = face(None, None).unwrap();
        assert!(SHAPES.contains(&picked.shape.as_str()) && HUES.contains(&picked.hue));
        assert!(face(Some("droplet"), None).is_err(), "the droplet is left out, as in the app");
        assert!(face(None, Some(400.0)).is_err());
    }

    fn event(payload: serde_json::Value, subagent: bool) -> crate::events::AgentEvent {
        let mut event = crate::events::AgentEvent::mint(
            "s".into(),
            Harness::ClaudeCode,
            0,
            None,
            None,
            serde_json::from_value(payload).unwrap(),
        );
        if subagent {
            event.subagent = Some(crate::events::Subagent { id: "a".into(), label: None });
        }
        event
    }

    #[test]
    fn replay_keeps_the_conversation_and_drops_the_rest() {
        use serde_json::json;
        let prompt = |text: &str, kickoff: bool, from: serde_json::Value| {
            json!({"type": "user_message", "text": text, "images": [], "issues": [], "kickoff": kickoff, "from": from})
        };
        let said = |text: &str| json!({"type": "assistant_text", "block": null, "text": text});
        let events = vec![
            event(prompt("[Dray: greet]", true, json!(null)), false),
            event(said("Hi Yogesh"), false),
            event(prompt("ship it", false, json!(null)), false),
            event(said("subagent chatter"), true),
            event(json!({"type": "error", "source": "harness", "message": "boom", "fatal": false}), false),
            event(said("  "), false),
            event(prompt("[message from the Dray session \"T\" (x)]\n\ndone", false, json!({"sessionId": "x", "title": "T"})), false),
            event(said("It landed."), false),
        ];
        assert_eq!(
            replay(&events),
            vec![
                "You: Hi Yogesh",
                "User: ship it",
                "[message from the Dray session \"T\" (x)]\n\ndone",
                "You: It landed.",
            ]
        );
    }

    #[test]
    fn replay_keeps_the_tail_of_a_message_too_long_to_fit() {
        let entries = vec!["old".to_string(), format!("You: {}", "é".repeat(20)), "User: hi".to_string()];
        let (kept, cut) = newest_within(&entries, 20);
        assert!(cut);
        assert_eq!(kept.last().unwrap(), "User: hi");
        assert!(kept[0].starts_with('…') && kept[0].ends_with('é'));
        assert_eq!(newest_within(&entries, 1000), (entries.clone(), false));
    }

    #[test]
    fn the_block_speaks_of_the_file_only_where_the_bot_must_act() {
        assert!(bot_block(&bot(), &[], " \n", None, Harness::ClaudeCode).contains("is empty: your job is whatever the user tells you first"));
        let long = "é".repeat(FILE_CAP + 1);
        assert!(bot_block(&bot(), &[], &long, None, Harness::ClaudeCode).contains(&format!("is {} characters, over its", FILE_CAP + 1)));
        assert!(!bot_block(&bot(), &[], "Watch CI.", None, Harness::ClaudeCode).contains("characters, over its"));
    }

    #[test]
    fn every_template_is_filled_whole() {
        let block = bot_block(&bot(), &[], "a", Some("Yogesh"), Harness::ClaudeCode);
        let kickoff = fill(KICKOFF_PROMPT, &[("name", "Ops"), ("projects", "dray"), ("greet", "Hi"), ("unnamed", "")]);
        let review = fill(include_str!("bots/review_prompt.md"), &[("reason", "The user just corrected you.")]);
        for text in [&block, &kickoff, &review] {
            assert!(!text.contains('{'), "{text}");
        }
        assert!(block.contains(INSTRUCTIONS));
    }

    #[test]
    fn the_bot_is_told_its_name_and_the_users() {
        let known = bot_block(&bot(), &[], "", Some("Yogesh"), Harness::ClaudeCode);
        assert!(known.starts_with("# Your name is Ops"));
        assert!(known.contains("Call the user Yogesh."));
        let unknown = bot_block(&bot(), &[], "", None, Harness::ClaudeCode);
        assert!(unknown.contains("Never guess it"));
        assert!(unknown.contains(USER_FILE));
    }

    #[test]
    fn the_greeting_asks_the_name_only_while_nobody_knows_it() {
        let dray = Bot { name: "Jarvis".into(), welcome: Some("old words".into()), ..bot() };
        let asking = greeting(&dray, None);
        assert_eq!(asking.len(), 2);
        assert!(asking[0].starts_with("Hi! I'm Jarvis,"));
        assert_eq!(asking[1], ASK_NAME);
        assert_eq!(greeting(&dray, Some("Yogesh")), vec![welcome_text("Jarvis", Some("Yogesh"))]);
        assert!(greeting(&bot(), None).is_empty());
    }

    #[test]
    fn a_written_name_is_kept_to_one_short_line() {
        assert_eq!(clean_name("\n# Yogesh\nmore").as_deref(), Some("Yogesh"));
        assert_eq!(clean_name("\"Yogi\" [x]").as_deref(), Some("Yogi x"));
        assert_eq!(clean_name(&"a".repeat(100)).map(|n| n.len()), Some(60));
        assert_eq!(clean_name(" \n\n"), None);
    }

    #[test]
    fn a_newer_note_replaces_one_of_its_kind() {
        let path = "/h/bots/notes-test";
        note_bot(path, Note::Renamed, "The user renamed you from \"A\" to \"B\".".into());
        note_bot(path, Note::UserName, "The user asked to be called Y.".into());
        note_bot(path, Note::Renamed, "The user renamed you from \"B\" to \"C\".".into());
        let mine: Vec<String> =
            NOTES.lock().unwrap().iter().filter(|(p, _)| p == path).map(|(_, n)| n.clone()).collect();
        assert_eq!(mine.len(), 2);
        assert!(mine.iter().any(|n| n.contains("to \"C\"")));
        NOTES.lock().unwrap().retain(|(p, _)| p != path);
    }

    #[tokio::test]
    async fn old_instructions_move_to_agents_md_in_a_commit_of_their_own() {
        let dir = std::env::temp_dir().join(format!("dray-bot-{}", uuid::Uuid::now_v7()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join(LEGACY_INSTRUCTIONS), "# Ops\n\n- Watch CI\n").await.unwrap();
        let bot = Bot { path: dir.to_string_lossy().into_owned(), ..bot() };
        start_history(&bot).await.unwrap();

        write_pointer(&dir).await;
        move_legacy_instructions(&bot).await.unwrap();
        move_legacy_instructions(&bot).await.unwrap();
        assert_eq!(tokio::fs::read_to_string(dir.join(INSTRUCTIONS)).await.unwrap(), "# Ops\n\n- Watch CI\n");
        assert!(!dir.join(LEGACY_INSTRUCTIONS).exists());
        assert_eq!(tokio::fs::read_to_string(dir.join(CLAUDE_POINTER)).await.unwrap(), POINTER_TEXT);
        let log = git(&dir, &["log", "--format=%s"]).await.unwrap();
        assert_eq!(log, "Move INSTRUCTIONS.md to AGENTS.md\nStart history\n");
        assert_eq!(git(&dir, &["status", "--porcelain"]).await.unwrap(), "", "the pointer is ignored, the rest committed");
        assert_eq!(git(&dir, &["ls-files"]).await.unwrap(), ".gitignore\nAGENTS.md\n");

        // A second write leaves the ignore rule and a pointer already there alone.
        tokio::fs::write(dir.join(CLAUDE_POINTER), "mine").await.unwrap();
        write_pointer(&dir).await;
        assert_eq!(tokio::fs::read_to_string(dir.join(".gitignore")).await.unwrap(), "/CLAUDE.md\n");
        assert_eq!(tokio::fs::read_to_string(dir.join(CLAUDE_POINTER)).await.unwrap(), "mine");
        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn old_instructions_join_an_agents_md_already_there() {
        let dir = std::env::temp_dir().join(format!("dray-bot-{}", uuid::Uuid::now_v7()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join(LEGACY_INSTRUCTIONS), "- Old rule\n").await.unwrap();
        tokio::fs::write(dir.join(INSTRUCTIONS), "- New rule\n").await.unwrap();
        let bot = Bot { path: dir.to_string_lossy().into_owned(), ..bot() };
        move_legacy_instructions(&bot).await.unwrap();
        assert_eq!(tokio::fs::read_to_string(dir.join(INSTRUCTIONS)).await.unwrap(), "- New rule\n\n- Old rule\n");
        assert!(!dir.join(LEGACY_INSTRUCTIONS).exists());
        assert!(NOTES.lock().unwrap().iter().any(|(p, n)| p == &bot.path && n.starts_with("Your instructions moved")));
        NOTES.lock().unwrap().retain(|(p, _)| p != &bot.path);

        // Cut off after the write and before the removal: the next start
        // finds both, and must not append the old rules a second time.
        tokio::fs::write(dir.join(LEGACY_INSTRUCTIONS), "- Old rule\n").await.unwrap();
        move_legacy_instructions(&bot).await.unwrap();
        assert_eq!(tokio::fs::read_to_string(dir.join(INSTRUCTIONS)).await.unwrap(), "- New rule\n\n- Old rule\n");
        assert!(!dir.join(LEGACY_INSTRUCTIONS).exists());

        // A rule only contained in a longer one was never copied.
        tokio::fs::write(dir.join(INSTRUCTIONS), "- Always ask before deleting\n").await.unwrap();
        tokio::fs::write(dir.join(LEGACY_INSTRUCTIONS), "- Always ask\n").await.unwrap();
        move_legacy_instructions(&bot).await.unwrap();
        assert_eq!(
            tokio::fs::read_to_string(dir.join(INSTRUCTIONS)).await.unwrap(),
            "- Always ask before deleting\n\n- Always ask\n"
        );
        NOTES.lock().unwrap().retain(|(p, _)| p != &bot.path);
        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn history_starts_once_and_commits_only_a_change() {
        let dir = std::env::temp_dir().join(format!("dray-bot-{}", uuid::Uuid::now_v7()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join(INSTRUCTIONS), "").await.unwrap();
        let bot = Bot { path: dir.to_string_lossy().into_owned(), ..bot() };
        let log = || async { git(&dir, &["log", "--format=%an|%s"]).await.unwrap() };

        start_history(&bot).await.unwrap();
        start_history(&bot).await.unwrap();
        assert_eq!(log().await, "Ops|Start history\n");

        commit_all(&bot, None).await.unwrap();
        assert_eq!(log().await.lines().count(), 1);

        tokio::fs::create_dir_all(dir.join(MEMORY)).await.unwrap();
        tokio::fs::write(dir.join(MEMORY).join("tea.md"), "likes tea").await.unwrap();
        commit_all(&bot, None).await.unwrap();
        assert_eq!(log().await.lines().next(), Some("Ops|Update memory/tea.md"));
        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    #[test]
    fn since_folds_acts_per_task_and_keeps_the_newest_tasks() {
        let mut tasks = Vec::new();
        fold_since(&mut tasks, "a", "Boat", "merged its PR #980 (Boat)".into());
        fold_since(&mut tasks, "a", "Boat", "settled it".into());
        fold_since(&mut tasks, "a", "Boat", "settled it".into());
        assert_eq!(
            since_text(&tasks),
            "[Since your last turn, outside this chat:\n- Task \"Boat\" (a): the user merged its PR #980 (Boat), then settled it.]\n\n"
        );
        for i in 0..SINCE_CAP {
            fold_since(&mut tasks, &i.to_string(), "t", "stopped its turn".into());
        }
        assert_eq!(tasks.len(), SINCE_CAP);
        assert_eq!(tasks[0].0, "0");
    }

    #[test]
    fn a_turn_message_names_three_files_at_most() {
        assert_eq!(turn_message(&["a", "b", "c", "d", "e"]), "Update a, b, c and 2 more");
    }

    #[test]
    fn a_folder_inside_a_bot_is_the_bots() {
        assert!(holds("/h/bots/b", "/h/bots/b/memory"));
        assert!(holds("/h/bots/b", "/h/bots/b/"));
        assert!(!holds("/h/bots/b", "/h/bots/bb"));
    }

    #[test]
    fn dirs_match_with_or_without_a_trailing_slash() {
        assert!(same_dir("/h/bots/b/", "/h/bots/b"));
        assert!(!same_dir("/h/bots/b", "/h/bots/bb"));
    }
}
