//! Sends `continue` to a session whose turn died on the usage limit, shortly
//! after the limit resets (#477).
//!
//! Claude Code only, and not by a check here: it is the one harness that says
//! when its limit resets, so it is the only one that ever reaches [`schedule`].
//!
//! The schedule lives on the index entry, not in a timer's memory. The server
//! restarts itself whenever it is idle and out of date, and a limited session
//! is exactly an idle one — so a timer alone would be lost to the very update
//! that ships while the reader waits. [`rearm`] puts them back at startup.

use chrono::{DateTime, Duration, Utc};

use crate::{orchestration::SESSION_CHANGED, session::manager, sink::Sink, store};

/// What the session is sent. A word the reader would type themselves, drawn in
/// the transcript like any prompt, so it is plain why the turn restarted.
const PROMPT: &str = "continue";

/// How long after the reset the prompt goes out. The reset time is the CLI's
/// own clock, and a prompt landing a second early is refused and re-schedules
/// for the *next* window.
const MARGIN: Duration = Duration::seconds(60);

/// Records a continue for a minute after `resets_at` and arms its timer. A
/// reset already past is skipped: the CLI reporting a stale time would
/// otherwise loop a refused `continue` every turn.
pub async fn schedule(session_id: &str, resets_at: &str, sink: &Sink) {
    let Ok(reset) = DateTime::parse_from_rfc3339(resets_at) else {
        return;
    };
    if reset <= Utc::now() {
        return;
    }
    let at = (reset + MARGIN).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    match store::set_continue_at(session_id, &at).await {
        Ok(Some(item)) => {
            sink.emit(SESSION_CHANGED, &item).ok();
            arm(session_id.to_string(), at, sink.clone());
        }
        Ok(None) => {}
        Err(e) => eprintln!("[auto-continue] could not schedule {session_id}: {e:#}"),
    }
}

/// The reader's Cancel, and turning it back on. No timer to touch either way:
/// the one armed with the schedule reads the flag when it wakes. Sending a
/// prompt drops the schedule outright, inside the send itself.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_auto_continue(session_id: String, on: bool, sink: Sink) -> Result<(), crate::Fail> {
    if let Some(item) = store::set_continue_off(&session_id, !on).await? {
        sink.emit(SESSION_CHANGED, &item).ok();
    }
    Ok(())
}

/// Re-arms every schedule the index holds, cancelled ones too, at server
/// startup — so every schedule always has a timer to retire it. One already
/// due fires at once.
pub async fn rearm(sink: &Sink) {
    let items = match store::read_index().await {
        Ok(items) => items,
        Err(e) => return eprintln!("[auto-continue] could not read index: {e:#}"),
    };
    for item in items {
        if let Some(at) = item.continue_at {
            arm(item.session_id, at, sink.clone());
        }
    }
}

/// Sleeps until `at`, then sends — `send_msg` claims the schedule under the
/// session's lock and sends only if it still names `at` and the reader has not
/// cancelled it. Nothing stops the sleep itself, which is cheaper than holding
/// a handle per session: a send or a newer schedule moves the field and this
/// wakes to find it gone.
fn arm(session_id: String, at: String, sink: Sink) {
    tokio::spawn(async move {
        let Ok(when) = DateTime::parse_from_rfc3339(&at) else {
            return;
        };
        if let Ok(wait) = (when.with_timezone(&Utc) - Utc::now()).to_std() {
            tokio::time::sleep(wait).await;
        }
        let item = match store::get_session_index_item(&session_id).await {
            Ok(Some(item)) => item,
            Ok(None) => return,
            Err(e) => return eprintln!("[auto-continue] {session_id}: {e:#}"),
        };
        // The session's own recorded settings, like a relayed message: the
        // continue must not move the session onto anything it was not on.
        let sent = manager()
            .send_msg(
                &item.session_id, PROMPT, &[], &[], item.harness, item.model, item.effort,
                item.permission_mode, item.fast, &item.cwd, None, false, None, None, false,
                None, false, None, None, Some(&at), &sink,
            )
            .await;
        if let Err(e) = sent {
            eprintln!("[auto-continue] could not continue {session_id}: {e:#}");
        }
    });
}
