//! Set aside, or brought back, while the session's server is down (#1050).
//!
//! A task on a stopped sandbox is often the very one somebody wants out of the
//! way, and only its own server can write its row. So the flag is held here,
//! beside this server's sessions, in `held-flags.json`: the app draws it at once
//! off `held_flags_changed`, and [`run`] writes it to the task's server once
//! that answers. The app asks for that write at once when it sees the server
//! reconnect (`flush_held_flags`), so the row never waits out a backoff.
//!
//! Only `aside`, with the `pinned` that rides along with it. Settling stops the
//! session's child, which nothing can do while its server is down.

use crate::{events::now_rfc3339, store};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex},
};

/// One session's flag, waiting on its server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    /// The machine's id in `servers.json`, the app's server id too.
    pub machine: String,
    pub session_id: String,
    pub aside: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    /// When it was held. Bringing one back restarts the sidebar's three-day
    /// clock, so the app reads this as the row's `modified` until it lands.
    pub at: String,
}

/// The file is rewritten whole by the app's calls, the CLI's and the flush.
static FILE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn path() -> anyhow::Result<PathBuf> {
    Ok(store::get_home_app_dir().await?.join("held-flags.json"))
}

/// Every flag waiting on its server.
pub async fn list() -> Vec<Held> {
    let Ok(path) = path().await else { return Vec::new() };
    store::read_json(&path).await.unwrap_or_default()
}

/// Which machine holds `session_id`, as far as a flag held for it says.
pub async fn machine_of(session_id: &str) -> Option<String> {
    list().await.into_iter().find(|h| h.session_id == session_id).map(|h| h.machine)
}

/// Rewrites the list through `change`, answering whether it moved.
async fn edit(change: impl FnOnce(&mut Vec<Held>)) -> anyhow::Result<bool> {
    let _guard = FILE.lock().await;
    let path = path().await?;
    let mut list: Vec<Held> = store::read_json(&path).await?;
    let before = list.clone();
    change(&mut list);
    if list == before {
        return Ok(false);
    }
    store::write_atomic(&path, serde_json::to_string_pretty(&list)?).await?;
    Ok(true)
}

/// Holds `aside` (and `pinned`) for `session_id` on `machine`, replacing what
/// was held for it: the newest press is the one the reader means.
pub async fn hold(machine: &str, session_id: &str, aside: bool, pinned: Option<bool>) -> anyhow::Result<Held> {
    let held = Held { machine: machine.into(), session_id: session_id.into(), aside, pinned, at: now_rfc3339() };
    let entry = held.clone();
    edit(|list| {
        list.retain(|h| h.session_id != session_id);
        list.push(entry);
    })
    .await?;
    Ok(held)
}

/// Held for as long as a flush is writing to that machine, so a change made
/// meanwhile waits and lands after the flag it supersedes, never before it.
static MACHINES: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Default::default);

fn machine_lock(machine: &str) -> Arc<tokio::sync::Mutex<()>> {
    MACHINES.lock().unwrap_or_else(|e| e.into_inner()).entry(machine.to_string()).or_default().clone()
}

/// Drops what is held for `session_id`, once any flush writing it has
/// finished, so the caller's own write to that server lands last. Answers
/// what was held, landed meanwhile or not: a flag that did land may need
/// undoing by the caller.
pub async fn unhold(session_id: &str) -> anyhow::Result<Option<Held>> {
    let Some(held) = list().await.into_iter().find(|h| h.session_id == session_id) else { return Ok(None) };
    let lock = machine_lock(&held.machine);
    let _writing = lock.lock().await;
    edit(|list| list.retain(|h| h.session_id != session_id)).await?;
    Ok(Some(held))
}

/// Flags a flush wrote lately, by session and the time they were held. What
/// [`release`] reads to tell a flag that landed during a send from one that
/// was dropped or replaced.
static LANDED: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn note_landed(held: &Held) {
    let mut landed = LANDED.lock().unwrap_or_else(|e| e.into_inner());
    landed.push((held.session_id.clone(), held.at.clone()));
    let over = landed.len().saturating_sub(64);
    landed.drain(..over);
}

/// What became of a flag held when a send went out.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Released {
    /// Still held, and dropped now: it never reached the server.
    Held,
    /// A flush wrote it to the server, possibly after the send landed.
    Landed,
    /// The reader chose again since; that newer flag stays held.
    Newer,
    /// Dropped some other way.
    Gone,
}

/// Settles the flag held at `at` once a message has reached its session,
/// behind any flush writing it.
pub async fn release(session_id: &str, at: &str) -> anyhow::Result<Released> {
    let Some(machine) = machine_of(session_id).await else { return Ok(took_landed(session_id, at)) };
    let lock = machine_lock(&machine);
    let _writing = lock.lock().await;
    match list().await.into_iter().find(|h| h.session_id == session_id) {
        Some(held) if held.at == at => {
            edit(|list| list.retain(|h| h.session_id != session_id)).await?;
            Ok(Released::Held)
        }
        Some(_) => Ok(Released::Newer),
        None => Ok(took_landed(session_id, at)),
    }
}

fn took_landed(session_id: &str, at: &str) -> Released {
    let mut landed = LANDED.lock().unwrap_or_else(|e| e.into_inner());
    match landed.iter().position(|(s, a)| s == session_id && a == at) {
        Some(i) => {
            landed.remove(i);
            Released::Landed
        }
        None => Released::Gone,
    }
}

#[cfg(any(feature = "serve", feature = "desktop"))]
mod flush {
    use super::*;
    use crate::{machines, sink::Sink};
    use serde_json::{json, Value};
    use std::time::{Duration, Instant};

    /// How often a held flag is tried while nothing says its server is back.
    const POLL: Duration = Duration::from_secs(30);
    /// A stopped sandbox costs a login per try, so a dead one is tried every
    /// few minutes at most. The app's reconnect skips the wait.
    const BACKOFF_CAP: Duration = Duration::from_secs(300);

    static BACKOFF: LazyLock<Mutex<HashMap<String, (Instant, Duration)>>> = LazyLock::new(Default::default);

    /// What `held_flags_changed` carries: everything still held, and the rows
    /// a flush just wrote, as their servers answered them.
    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Changed {
        pub held: Vec<Held>,
        pub landed: Vec<Landed>,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Landed {
        pub server: String,
        pub item: Value,
    }

    /// Tells every client what is held now.
    pub async fn announce(sink: &Sink, landed: Vec<Landed>) {
        let changed = Changed { held: list().await, landed };
        if let Err(e) = sink.emit("held_flags_changed", &changed) {
            eprintln!("[held flags emit err] {e}");
        }
    }

    /// The serve command `hold_session_flags`: the app's Set aside on a row
    /// whose server is not connected.
    pub async fn hold_and_announce(
        machine: String,
        session_id: String,
        aside: bool,
        pinned: Option<bool>,
        sink: Sink,
    ) -> Result<Held, String> {
        let held = hold(&machine, &session_id, aside, pinned).await.map_err(|e| format!("{e:#}"))?;
        announce(&sink, Vec::new()).await;
        Ok(held)
    }

    /// The serve command `unhold_session_flags`.
    pub async fn unhold_and_announce(session_id: String, sink: Sink) -> Result<Option<Held>, String> {
        let dropped = unhold(&session_id).await.map_err(|e| format!("{e:#}"))?;
        if dropped.is_some() {
            announce(&sink, Vec::new()).await;
        }
        Ok(dropped)
    }

    /// The serve command `release_held_flag`.
    pub async fn release_and_announce(session_id: String, at: String, sink: Sink) -> Result<Released, String> {
        let released = release(&session_id, &at).await.map_err(|e| format!("{e:#}"))?;
        if released == Released::Held {
            announce(&sink, Vec::new()).await;
        }
        Ok(released)
    }

    /// Runs for the life of the server. A file read per tick while nothing is
    /// held.
    pub async fn run(sink: Sink) {
        let mut tick = tokio::time::interval(POLL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            flush(&sink, None).await;
        }
    }

    /// The serve command `flush_held_flags`: `machine` just connected to the
    /// app, so its flags go now, whatever the backoff said.
    pub async fn flush_now(machine: String, sink: Sink) {
        BACKOFF.lock().unwrap_or_else(|e| e.into_inner()).remove(&machine);
        flush(&sink, Some(&machine)).await;
    }

    /// Writes each held flag to its server, `only` that machine's where given.
    /// A reconnect's flush and the timer's can overlap; each machine's lock
    /// and the re-read under it keep one flag from being written twice.
    async fn flush(sink: &Sink, only: Option<&str>) {
        let mut ids: Vec<String> = list().await.into_iter().map(|h| h.machine).collect();
        ids.sort();
        ids.dedup();
        ids.retain(|id| only.is_none_or(|m| m == id));
        if ids.is_empty() {
            return;
        }
        let machines = machines::load().await;
        let mut landed = Vec::new();
        let mut moved = false;
        for id in ids {
            let lock = machine_lock(&id);
            let _writing = lock.lock().await;
            let mine: Vec<Held> = list().await.into_iter().filter(|h| h.machine == id).collect();
            let mut done: Vec<Held> = Vec::new();
            match machines.iter().find(|m| m.id == id) {
                // Removed, token and all: nothing will ever reach it again.
                None => done = mine,
                Some(saved) => {
                    let now = Instant::now();
                    let waiting = BACKOFF.lock().unwrap_or_else(|e| e.into_inner()).get(&id).is_some_and(|(at, _)| now < *at);
                    if saved.off || waiting {
                        continue;
                    }
                    for held in mine {
                        let args = json!({ "sessionId": held.session_id, "aside": held.aside, "pinned": held.pinned });
                        let answer = tokio::time::timeout(machines::SWEEP, machines::call(saved, "set_session_flags", args))
                            .await
                            .unwrap_or_else(|_| Err(format!("{} did not answer in time", saved.name)));
                        match answer {
                            Ok(item) => {
                                BACKOFF.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                                // Null is a session that server no longer has:
                                // nothing left to write it to.
                                if !item.is_null() {
                                    landed.push(Landed { server: id.clone(), item });
                                }
                                note_landed(&held);
                                done.push(held);
                            }
                            Err(e) => {
                                let mut backoff = BACKOFF.lock().unwrap_or_else(|e| e.into_inner());
                                let wait = backoff.get(&id).map_or(POLL, |(_, w)| (*w * 2).min(BACKOFF_CAP));
                                backoff.insert(id.clone(), (now + wait, wait));
                                eprintln!("[held flags err] {}: {e}", saved.name);
                                break;
                            }
                        }
                    }
                }
            }
            if done.is_empty() {
                continue;
            }
            // Only the flag as it was sent: one pressed again meanwhile is
            // newer than what landed, and goes on the next flush.
            match edit(|list| list.retain(|h| !done.contains(h))).await {
                Ok(_) => moved = true,
                Err(e) => eprintln!("[held flags err] {e:#}"),
            }
        }
        if moved {
            announce(sink, landed).await;
        }
    }
}

#[cfg(any(feature = "serve", feature = "desktop"))]
pub use flush::{announce, flush_now, hold_and_announce, release_and_announce, run, unhold_and_announce};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_held_flag_reads_back_as_written() {
        let held = Held {
            machine: "m".into(),
            session_id: "s".into(),
            aside: true,
            pinned: Some(false),
            at: "2026-11-14T00:00:00Z".into(),
        };
        let wire = serde_json::to_value(&held).unwrap();
        assert_eq!(wire["sessionId"], "s");
        assert_eq!(wire["pinned"], false);
        assert_eq!(serde_json::from_value::<Held>(wire).unwrap(), held);
        // Bringing back takes no pin, and says none.
        let back = Held { pinned: None, aside: false, ..held };
        assert!(serde_json::to_value(&back).unwrap().get("pinned").is_none());
    }

    /// A send's undo goes only where the flush wrote that very flag, and once.
    #[test]
    fn only_the_flag_a_flush_wrote_reads_as_landed() {
        let held = Held {
            machine: "m".into(),
            session_id: "landed-test".into(),
            aside: true,
            pinned: None,
            at: "2026-11-14T00:00:00Z".into(),
        };
        note_landed(&held);
        assert_eq!(took_landed("landed-test", "2026-11-14T00:00:01Z"), Released::Gone);
        assert_eq!(took_landed("landed-test", &held.at), Released::Landed);
        assert_eq!(took_landed("landed-test", &held.at), Released::Gone);
    }
}
