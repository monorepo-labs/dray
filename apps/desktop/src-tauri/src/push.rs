//! Phone alerts (#1299): a turn done, a permission or a question asked, a
//! pull request ready to merge, sent through the push relay on drayhq.com,
//! which alone holds the APNs key.
//!
//! A phone registers over the serve wire with a handle the relay sealed its
//! APNs token into, and a tag: its own id for this server, echoed back so a
//! tap opens the right chat. The handles live in `<home>/push.json`.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::events::{AgentEventPayload, PermissionOptionKind};
use crate::store;

#[derive(Clone, Serialize, Deserialize)]
struct Phone {
    handle: String,
    tag: String,
    /// The kinds this phone turned off. Kept as what is off, so a kind added
    /// later reaches a phone that never heard of it.
    #[serde(default)]
    off: Vec<String>,
}

/// Every read-modify-write of the file goes through this, so a register racing a 410's removal loses nothing.
static FILE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn path() -> Result<std::path::PathBuf, String> {
    Ok(store::get_home_app_dir().await.map_err(|e| format!("{e:#}"))?.join("push.json"))
}

async fn read() -> Vec<Phone> {
    let Ok(path) = path().await else { return vec![] };
    tokio::fs::read(path).await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

async fn update(change: impl FnOnce(&mut Vec<Phone>)) -> Result<(), String> {
    let _held = FILE.lock().await;
    let mut phones = read().await;
    change(&mut phones);
    let bytes = serde_json::to_vec_pretty(&phones).map_err(|e| e.to_string())?;
    let path = path().await?;
    store::write_private_atomic(&path, &bytes).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// A phone asks for this server's alerts, bar the kinds in `off`. A tag
/// already held takes the new handle, since a phone that re-registered with
/// APNs has a new token. `off` is absent from a phone built before it.
pub async fn push_register(handle: String, tag: String, off: Option<Vec<String>>) -> Result<(), String> {
    if !handle.starts_with("dph_") || handle.len() > 512 || tag.is_empty() || tag.len() > 64 {
        return Err("not a push handle".into());
    }
    update(|phones| {
        phones.retain(|p| p.tag != tag && p.handle != handle);
        phones.push(Phone { handle, tag, off: off.unwrap_or_default() });
    })
    .await
}

/// A phone that turned alerts off, or a handle the relay says is gone.
pub async fn push_unregister(handle: String) -> Result<(), String> {
    update(|phones| phones.retain(|p| p.handle != handle)).await
}

/// The Mac's server leaves an alert to the desktop while someone used it in
/// the last two minutes. A headless server has nobody at it, so it always pushes.
fn at_the_computer() -> bool {
    #[cfg(feature = "desktop")]
    return crate::apps::idle_seconds().is_some_and(|s| s < 120.0);
    #[allow(unreachable_code)]
    false
}

/// A turn's last words as one line an alert can hold: the first line with
/// text, its markdown marks dropped.
fn first_line(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let line = line.trim_start_matches(['#', '>', '-', '*', ' ']).replace("**", "").replace('`', "");
    let mut out: String = line.chars().take(200).collect();
    if line.chars().count() > 200 {
        out.push('…');
    }
    out
}

/// Who an alert is from, and the bot's face where it is a bot's chat.
/// `None` for a session that stays quiet: a hidden task its bot reports on.
async fn sender(session_id: &str) -> Option<(String, Option<Value>)> {
    let item = store::get_session_index_item(session_id).await.ok().flatten()?;
    if let Some(bot) = crate::bots::bot_at(&item.cwd).await {
        let face = json!({ "id": bot.id, "shape": bot.avatar.as_ref().map(|a| &a.shape), "hue": bot.avatar.as_ref().map(|a| a.hue) });
        return Some((bot.name, Some(face)));
    }
    if item.hidden {
        return None;
    }
    Some((item.title, None))
}

/// The alert a payload raises, if any, without who it is from.
fn alert(payload: &AgentEventPayload, said: Option<&str>) -> Option<Value> {
    match payload {
        AgentEventPayload::TurnCompleted { status, stop_reason, .. } => {
            // The reader's own Stop needs no alert.
            if stop_reason.as_deref().is_some_and(|r| r.starts_with("aborted")) {
                return None;
            }
            let failed = *status == crate::events::TurnStatus::Error;
            let body = said.map(first_line).filter(|l| !l.is_empty());
            Some(json!({ "kind": "done", "body": body.unwrap_or_else(|| if failed { "Turn failed" } else { "Done" }.into()) }))
        }
        AgentEventPayload::PermissionRequested { request_id, tool_name, display_name, title, description, options, .. } => {
            let pick = |kind| options.iter().find(|o| o.kind == kind).map(|o| o.id.clone());
            let tool = display_name.as_deref().unwrap_or(tool_name);
            let body = title.clone().or_else(|| description.clone()).unwrap_or_else(|| format!("Wants to use {tool}"));
            Some(json!({
                "kind": "permission",
                "body": first_line(&body),
                "request": request_id,
                "allow": pick(PermissionOptionKind::Once),
                "deny": pick(PermissionOptionKind::Deny),
            }))
        }
        AgentEventPayload::QuestionsAsked { request_id, questions, .. } => {
            let first = questions.first()?;
            // Several questions are answered in the app; one can be from the alert.
            let question = (questions.len() == 1).then(|| {
                json!({
                    "text": first.question,
                    "options": first.options.iter().map(|o| &o.label).collect::<Vec<_>>(),
                    "freeText": first.free_text,
                })
            });
            Some(json!({ "kind": "question", "body": first_line(&first.question), "request": request_id, "question": question }))
        }
        // Named for the task, not the chat it is posted in: a bot's chat holds many.
        AgentEventPayload::MergeCard { title, number, url, .. } => {
            let pr = match crate::github::slug_from_pr_url(url) {
                Some(repo) => format!("{repo}#{number}"),
                None => format!("#{number}"),
            };
            Some(json!({ "kind": "ready", "title": title, "body": format!("{pr} is ready to merge") }))
        }
        _ => None,
    }
}

/// Sends the alert `payload` raises in `session_id` to every registered
/// phone that has its kind on. Spawned: the read loop never waits on the relay.
pub fn notify(session_id: &str, payload: &AgentEventPayload, said: Option<&str>) {
    let Some(mut alert) = alert(payload, said) else { return };
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        let kind = alert["kind"].as_str().unwrap_or_default().to_string();
        let phones: Vec<Phone> = read().await.into_iter().filter(|p| !p.off.contains(&kind)).collect();
        if phones.is_empty() || at_the_computer() {
            return;
        }
        let Some((name, bot)) = sender(&session_id).await else { return };
        alert["session"] = json!(session_id);
        if alert["title"].is_null() {
            alert["title"] = json!(name);
            alert["bot"] = json!(bot);
        }
        for phone in phones {
            let mut body = alert.clone();
            body["handle"] = json!(phone.handle);
            body["server"] = json!(phone.tag);
            let sent = crate::http()
                .post(format!("{}/api/push/send", crate::org_link::site()))
                .json(&body)
                .timeout(Duration::from_secs(15))
                .send()
                .await;
            match sent {
                Ok(r) if r.status() == reqwest::StatusCode::GONE => {
                    let _ = push_unregister(phone.handle).await;
                }
                Ok(r) if !r.status().is_success() => eprintln!("[push] relay answered {}", r.status()),
                Err(e) => eprintln!("[push] relay unreachable: {e}"),
                _ => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_line_drops_marks_and_blank_lines() {
        assert_eq!(first_line("\n\n## **Fixed** the `parser`\nmore"), "Fixed the parser");
        assert_eq!(first_line("- one\n- two"), "one");
        assert_eq!(first_line(&"x".repeat(300)).chars().count(), 201);
    }

    #[test]
    fn aborted_turn_raises_nothing() {
        let turn = |stop: Option<&str>| AgentEventPayload::TurnCompleted {
            status: crate::events::TurnStatus::Error,
            stop_reason: stop.map(Into::into),
            final_text: None,
            usage: None,
            duration_ms: None,
            head: None,
            auth_failed: false,
        };
        assert!(alert(&turn(Some("aborted_streaming")), None).is_none());
        assert_eq!(alert(&turn(None), None).unwrap()["body"], "Turn failed");
        assert_eq!(alert(&turn(None), Some("All green.\nDetails")).unwrap()["body"], "All green.");
    }

    #[test]
    fn ready_to_merge_names_the_task_and_pr() {
        let card = AgentEventPayload::MergeCard {
            task_id: "t".into(),
            title: "Fix login".into(),
            project_path: "/p".into(),
            branch: "b".into(),
            number: 12,
            url: "https://github.com/acme/app/pull/12".into(),
            machine: None,
            repo: None,
        };
        let a = alert(&card, None).unwrap();
        assert_eq!((a["kind"].as_str(), a["title"].as_str()), (Some("ready"), Some("Fix login")));
        assert_eq!(a["body"], "acme/app#12 is ready to merge");
    }

    #[test]
    fn a_phone_saved_before_kinds_hears_everything() {
        let phones: Vec<Phone> = serde_json::from_str(r#"[{"handle":"dph_x","tag":"t"}]"#).unwrap();
        assert!(phones[0].off.is_empty());
    }
}
