//! Reports from a bot's task on another machine (#958).
//!
//! A task's report goes to its parent from the task's own server, and a task
//! started with `--machine` runs on a server that usually cannot reach the
//! bot's: reach follows tokens, and the bot's server holds the task's, not the
//! other way round. So the task's server keeps each report, and the bot's
//! server, which made the task over its own link, collects and delivers it.
//!
//! Two files, one per side. `parent-reports.json` on the task's server holds
//! which tasks owe reports and the reports not yet collected;
//! `remote-tasks.json` on the bot's server holds which tasks to collect from.

use crate::store;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// One report waiting for the bot's server to collect it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// What an ack names. Time-ordered, so delivery keeps turn order.
    pub id: String,
    pub child: String,
    pub parent: String,
    /// The task's title when it reported, for the sender line.
    pub title: String,
    pub text: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Outbox {
    /// Tasks whose parent is a bot's chat on another machine.
    #[serde(default)]
    owed: Vec<String>,
    #[serde(default)]
    pending: Vec<Report>,
}

/// What a collect answers: the reports for the tasks asked about, and which of
/// them will never report again.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Taken {
    pub reports: Vec<Report>,
    pub gone: Vec<String>,
}

/// Both files are rewritten whole by more than one task.
static OUTBOX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn outbox_path() -> anyhow::Result<PathBuf> {
    Ok(store::get_home_app_dir().await?.join("parent-reports.json"))
}

async fn save_outbox(outbox: &Outbox) -> anyhow::Result<()> {
    store::write_atomic(&outbox_path().await?, serde_json::to_string_pretty(outbox)?).await
}

/// Marks `child` as a bot's task whose bot runs on another machine. Before it
/// spawns, so its system prompt already says its replies are relayed.
pub async fn owe(child: &str) -> anyhow::Result<()> {
    let _guard = OUTBOX.lock().await;
    let mut outbox: Outbox = store::read_json(&outbox_path().await?).await?;
    if !outbox.owed.iter().any(|c| c == child) {
        outbox.owed.push(child.to_string());
        save_outbox(&outbox).await?;
    }
    Ok(())
}

/// Whether `child` reports to a bot on another machine.
pub async fn owed(child: &str) -> bool {
    let Ok(path) = outbox_path().await else { return false };
    let outbox: Outbox = store::read_json(&path).await.unwrap_or_default();
    outbox.owed.iter().any(|c| c == child)
}

/// How long a report waits for collecting. A bot's server that removed this
/// machine, or never came back, says nothing, so nothing else clears its share.
const KEEP_FOR: u64 = 7 * 24 * 60 * 60;

/// Holds a report until the bot's server collects it.
pub async fn keep(child: &str, parent: &str, title: &str, text: String) -> anyhow::Result<()> {
    let _guard = OUTBOX.lock().await;
    let mut outbox: Outbox = store::read_json(&outbox_path().await?).await?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    outbox.expire(now);
    outbox.pending.push(Report {
        id: uuid::Uuid::now_v7().to_string(),
        child: child.to_string(),
        parent: parent.to_string(),
        title: title.to_string(),
        text,
    });
    save_outbox(&outbox).await
}

/// The serve command `parent_reports`: drops the reports `ack` names and the
/// tasks `forget` names, whose bot chat was settled, then answers the reports
/// waiting for `children`.
pub async fn take(children: Vec<String>, ack: Vec<String>, forget: Vec<String>) -> Result<Taken, String> {
    let _guard = OUTBOX.lock().await;
    let path = outbox_path().await.map_err(|e| format!("{e:#}"))?;
    let mut outbox: Outbox = store::read_json(&path).await.map_err(|e| format!("{e:#}"))?;
    let mut live = Vec::new();
    for child in &children {
        if store::get_session_index_item(child).await.ok().flatten().is_some_and(|c| !c.archived) {
            live.push(child.clone());
        }
    }
    let before = (outbox.owed.len(), outbox.pending.len());
    let taken = outbox.take(&children, &ack, &forget, &live);
    if (outbox.owed.len(), outbox.pending.len()) != before {
        save_outbox(&outbox).await.map_err(|e| format!("{e:#}"))?;
    }
    Ok(taken)
}

impl Outbox {
    /// A task missing here, settled, or never owed is `gone`, and its reports
    /// with it, so the asking server stops asking. `live` is which of
    /// `children` this index holds unsettled.
    fn take(&mut self, children: &[String], ack: &[String], forget: &[String], live: &[String]) -> Taken {
        self.pending.retain(|r| !ack.contains(&r.id));
        self.owed.retain(|c| !forget.contains(c));
        self.pending.retain(|r| !forget.contains(&r.child));
        let gone: Vec<String> =
            children.iter().filter(|c| !live.contains(c) || !self.owed.contains(c)).cloned().collect();
        self.owed.retain(|c| !gone.contains(c));
        self.pending.retain(|r| !gone.contains(&r.child));
        let reports = self.pending.iter().filter(|r| children.contains(&r.child)).cloned().collect();
        Taken { reports, gone }
    }

    /// Drops reports older than [`KEEP_FOR`], read off their v7 ids.
    fn expire(&mut self, now: u64) {
        self.pending.retain(|r| {
            let made = uuid::Uuid::parse_str(&r.id).ok().and_then(|id| id.get_timestamp()).map(|t| t.to_unix().0);
            made.is_none_or(|made| now.saturating_sub(made) < KEEP_FOR)
        });
    }
}

/// The bot's server's side: collecting from the machines its bots' tasks run on.
#[cfg(any(feature = "serve", feature = "desktop"))]
mod collect {
    use super::*;
    use crate::{events::MessageSender, machines, sink::Sink};
    use serde_json::json;
    use std::{
        collections::HashMap,
        time::{Duration, Instant},
    };

    /// How often each machine with a task here is asked. A report is the bot's
    /// next move, so this is the wait the reader sees on top of the turn.
    const POLL: Duration = Duration::from_secs(10);
    /// The longest a machine that fails to answer — a stopped sandbox — waits
    /// between asks, so a dead one costs a login every few minutes, not every poll.
    const BACKOFF_CAP: Duration = Duration::from_secs(300);

    /// A task on another machine whose reports belong to a bot chat here.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Remote {
        /// The machine's id in `servers.json`, which a rename leaves alone.
        pub machine: String,
        pub child: String,
        pub parent: String,
    }

    static TRACKED: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn tracked_path() -> anyhow::Result<PathBuf> {
        Ok(store::get_home_app_dir().await?.join("remote-tasks.json"))
    }

    async fn load() -> Vec<Remote> {
        let Ok(path) = tracked_path().await else { return Vec::new() };
        store::read_json(&path).await.unwrap_or_default()
    }

    /// Starts collecting `child`'s reports from `machine` for `parent`.
    pub async fn track(machine: &str, child: &str, parent: &str) -> anyhow::Result<()> {
        let _guard = TRACKED.lock().await;
        let mut list = load().await;
        list.push(Remote { machine: machine.into(), child: child.into(), parent: parent.into() });
        store::write_atomic(&tracked_path().await?, serde_json::to_string_pretty(&list)?).await
    }

    async fn untrack(children: &[String]) {
        if children.is_empty() {
            return;
        }
        let _guard = TRACKED.lock().await;
        let mut list = load().await;
        list.retain(|r| !children.contains(&r.child));
        let Ok(path) = tracked_path().await else { return };
        if let Err(e) = store::write_atomic(&path, serde_json::to_string_pretty(&list).unwrap_or_default()).await {
            eprintln!("[remote reports err] {e:#}");
        }
    }

    /// Runs for the life of the server. Each tick costs a file read while no
    /// task is out on another machine.
    pub async fn run(app: Sink) {
        let mut tick = tokio::time::interval(POLL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut backoff: HashMap<String, (Instant, Duration)> = HashMap::new();
        loop {
            tick.tick().await;
            collect(&app, &mut backoff).await;
        }
    }

    async fn collect(app: &Sink, backoff: &mut HashMap<String, (Instant, Duration)>) {
        let list = load().await;
        if list.is_empty() {
            return;
        }
        let machines = machines::load().await;
        let mut by_machine: HashMap<&str, Vec<&Remote>> = HashMap::new();
        for remote in &list {
            by_machine.entry(&remote.machine).or_default().push(remote);
        }
        let now = Instant::now();
        for (id, mine) in by_machine {
            let Some(saved) = machines.iter().find(|m| m.id == id) else {
                // Removed, token and all: nothing will ever reach it again.
                untrack(&mine.iter().map(|r| r.child.clone()).collect::<Vec<_>>()).await;
                continue;
            };
            if saved.off || backoff.get(id).is_some_and(|(at, _)| now < *at) {
                continue;
            }
            // The rule a local task's report follows: a settled chat takes
            // none. The task's server is told, or it keeps them for nobody.
            let (mut open, mut closed) = (Vec::new(), Vec::new());
            for remote in mine {
                let parent = store::get_session_index_item(&remote.parent).await.ok().flatten();
                match parent.is_none_or(|p| p.archived) {
                    true => closed.push(remote.child.clone()),
                    false => open.push(remote),
                }
            }
            let children: Vec<String> = open.iter().map(|r| r.child.clone()).collect();
            match ask(saved, &children, &[], &closed).await {
                Ok(taken) => {
                    backoff.remove(id);
                    untrack(&closed).await;
                    // Only this machine's own tasks: an answer naming another
                    // machine's is not its to close.
                    let gone: Vec<String> = taken.gone.into_iter().filter(|c| children.contains(c)).collect();
                    untrack(&gone).await;
                    let mut acked = Vec::new();
                    for report in taken.reports {
                        // Into the chat this server tracked the task under, never
                        // one the answer names: that machine holds no token here,
                        // so it must not pick which chat runs a turn.
                        let Some(remote) = open.iter().find(|r| r.child == report.child) else { continue };
                        if deliver(&report, &remote.parent, &saved.name, app).await {
                            acked.push(report.id);
                        }
                    }
                    if !acked.is_empty() {
                        // Lost, the reports come again next poll: a bot reading
                        // one twice beats a bot never reading it.
                        if let Err(e) = ask(saved, &[], &acked, &[]).await {
                            eprintln!("[remote reports ack err] {}: {e}", saved.name);
                        }
                    }
                }
                // A server from before #958 keeps no reports to collect.
                Err(e) if e.contains("unknown command") => {
                    untrack(&closed).await;
                    untrack(&children).await;
                }
                Err(e) => {
                    let wait = backoff.get(id).map_or(POLL, |(_, w)| (*w * 2).min(BACKOFF_CAP));
                    backoff.insert(id.to_string(), (now + wait, wait));
                    eprintln!("[remote reports err] {}: {e}", saved.name);
                }
            }
        }
    }

    async fn ask(saved: &machines::Saved, children: &[String], ack: &[String], forget: &[String]) -> Result<Taken, String> {
        let args = json!({ "children": children, "ack": ack, "forget": forget });
        let answer = tokio::time::timeout(machines::SWEEP, machines::call(saved, "parent_reports", args))
            .await
            .unwrap_or_else(|_| Err(format!("{} did not answer in time", saved.name)))?;
        serde_json::from_value(answer).map_err(|e| e.to_string())
    }

    /// Into the bot's chat `parent`, the way a local task's report goes, named
    /// as the task on `machine` so the bot can message it back with
    /// `dray session send`. False where the send failed, so the report is not
    /// acked and comes again next poll.
    async fn deliver(report: &Report, parent: &str, machine: &str, app: &Sink) -> bool {
        let from = MessageSender {
            session_id: report.child.clone(),
            title: report.title.clone(),
            machine: Some(machine.to_string()),
            bot_id: None,
            routine: None,
        };
        let sent = crate::orchestration::deliver_report(parent.to_string(), report.text.clone(), from, app.clone());
        match sent.await {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[remote reports deliver err] {e:#}");
                false
            }
        }
    }
}

#[cfg(any(feature = "serve", feature = "desktop"))]
pub use collect::{run, track};

#[cfg(test)]
mod tests {
    use super::*;

    fn report(id: &str, child: &str) -> Report {
        Report { id: id.into(), child: child.into(), parent: "chat".into(), title: "Task".into(), text: id.into() }
    }

    fn ids(taken: &Taken) -> Vec<&str> {
        taken.reports.iter().map(|r| r.id.as_str()).collect()
    }

    #[test]
    fn a_report_stays_until_acked_and_goes_only_to_who_asks() {
        let mut outbox = Outbox {
            owed: vec!["a".into(), "b".into()],
            pending: vec![report("1", "a"), report("2", "b"), report("3", "a")],
        };
        let live = ["a".to_string(), "b".to_string()];

        let taken = outbox.take(&["a".into()], &[], &[], &live);
        assert_eq!(ids(&taken), ["1", "3"]);
        assert!(taken.gone.is_empty());
        // Asked again unacked, the same reports come back.
        assert_eq!(ids(&outbox.take(&["a".into()], &[], &[], &live)), ["1", "3"]);

        let taken = outbox.take(&[], &["1".into(), "3".into()], &[], &live);
        assert!(taken.reports.is_empty());
        assert_eq!(outbox.pending, [report("2", "b")]);
    }

    #[test]
    fn a_settled_missing_or_unowed_task_is_gone_with_its_reports() {
        let mut outbox = Outbox { owed: vec!["a".into(), "b".into()], pending: vec![report("1", "a"), report("2", "b")] };
        // `a` settled or deleted here; `c` never owed a report.
        let taken = outbox.take(&["a".into(), "b".into(), "c".into()], &[], &[], &["b".into(), "c".into()]);
        assert_eq!(taken.gone, ["a", "c"]);
        assert_eq!(ids(&taken), ["2"]);
        assert_eq!(outbox.owed, ["b"]);
        assert_eq!(outbox.pending, [report("2", "b")]);
    }

    /// The bot's chat was settled: the task owes nothing more and its waiting
    /// reports go, or they would sit here for a server that stopped asking.
    #[test]
    fn a_forgotten_task_owes_nothing_more() {
        let mut outbox = Outbox { owed: vec!["a".into(), "b".into()], pending: vec![report("1", "a"), report("2", "b")] };
        let taken = outbox.take(&[], &[], &["a".into()], &["a".into(), "b".into()]);
        assert!(taken.reports.is_empty() && taken.gone.is_empty());
        assert_eq!(outbox.owed, ["b"]);
        assert_eq!(outbox.pending, [report("2", "b")]);
    }

    #[test]
    fn a_report_nobody_collects_expires() {
        let id = uuid::Uuid::now_v7().to_string();
        let mut outbox = Outbox { owed: vec!["a".into()], pending: vec![report(&id, "a")] };
        let made = uuid::Uuid::parse_str(&id).unwrap().get_timestamp().unwrap().to_unix().0;
        outbox.expire(made + KEEP_FOR - 1);
        assert_eq!(outbox.pending.len(), 1);
        outbox.expire(made + KEEP_FOR);
        assert!(outbox.pending.is_empty());
    }

    #[test]
    fn an_answer_reads_back_as_sent() {
        let taken = Taken { reports: vec![report("1", "a")], gone: vec!["b".into()] };
        let wire = serde_json::to_value(&taken).unwrap();
        assert_eq!(wire["reports"][0]["child"], "a");
        assert_eq!(serde_json::from_value::<Taken>(wire).unwrap(), taken);
    }
}
