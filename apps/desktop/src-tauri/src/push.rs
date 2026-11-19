//! Phone alerts (#1299): a turn done, a permission or a question asked, a
//! pull request ready to merge, sent through the push relay on drayhq.com,
//! which alone holds the APNs key.
//!
//! A phone registers over the serve wire with a handle the relay sealed its
//! APNs token into, and a tag: its own id for this server, echoed back so a
//! tap opens the right chat. The handles live in `<home>/push.json`.


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

/// Who an alert is from.
struct Sender {
    name: String,
    /// The bot's face, on its own chat's alerts alone.
    face: Option<Value>,
    /// The chat a tap opens where it is not the session itself: a bot's task
    /// opens the bot's chat, where its card waits.
    open: Option<String>,
}

/// `None` for a session that stays quiet: a hidden task's Done, which its bot
/// reports, and any alert from a hidden task outside a bot's tree.
async fn sender(session_id: &str, kind: &str) -> Option<Sender> {
    let item = store::get_session_index_item(session_id).await.ok().flatten()?;
    if let Some(bot) = crate::bots::bot_at(&item.cwd).await {
        let face = json!({ "id": bot.id, "shape": bot.avatar.as_ref().map(|a| &a.shape), "hue": bot.avatar.as_ref().map(|a| a.hue) });
        return Some(Sender { name: bot.name, face: Some(face), open: None });
    }
    if item.hidden && kind == "done" {
        return None;
    }
    // A bot's task looks like any task, but its chat is the bot's.
    if let Some(chat) = crate::bots::bot_chat_of(&item).await {
        let open = crate::bots::current_chat(chat).await.session_id;
        return Some(Sender { name: item.title, face: None, open: Some(open) });
    }
    // A bot on another machine started this one: its chat is in no index here,
    // so a tap opens the task, on this machine where it runs.
    if item.hidden && !crate::bots::in_bot_tree(&item).await {
        return None;
    }
    Some(Sender { name: item.title, face: None, open: None })
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
            // Only a question whose buttons answer it whole goes on the alert:
            // one alone, a single pick, and text the relay need not shorten,
            // since the answer is matched on the exact question and label.
            let fits = questions.len() == 1
                && !first.multi_select
                && first.options.len() <= 4
                && first.question.chars().count() <= 300
                && first.options.iter().all(|o| o.label.chars().count() <= 60);
            let question = fits.then(|| {
                json!({
                    "text": first.question,
                    "options": first.options.iter().map(|o| &o.label).collect::<Vec<_>>(),
                    "freeText": first.free_text,
                })
            });
            Some(json!({ "kind": "question", "body": first_line(&first.question), "request": request_id, "question": question }))
        }
        // Named for the task, not the chat it is posted in: a bot's chat holds many.
        AgentEventPayload::MergeCard { title, .. } => {
            Some(json!({ "kind": "ready", "title": title, "body": "Ready to merge" }))
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
        let Some(from) = sender(&session_id, &kind).await else { return };
        alert["session"] = json!(session_id);
        alert["open"] = json!(from.open);
        if alert["title"].is_null() {
            alert["title"] = json!(from.name);
            alert["bot"] = json!(from.face);
        }
        for phone in phones {
            let mut body = alert.clone();
            body["handle"] = json!(phone.handle);
            body["server"] = json!(phone.tag);
            match send(&body).await {
                Ok(reqwest::StatusCode::GONE) => {
                    let _ = push_unregister(phone.handle).await;
                }
                Ok(status) if !status.is_success() => eprintln!("[push] relay answered {status}"),
                Err(e) => eprintln!("[push] relay unreachable: {e}"),
                _ => {}
            }
        }
    });
}

/// Hands one alert to the relay, which lives on the site `org_link` names.
#[cfg(any(feature = "serve", feature = "desktop"))]
async fn send(body: &Value) -> Result<reqwest::StatusCode, reqwest::Error> {
    let url = format!("{}/api/push/send", crate::org_link::site());
    Ok(crate::http().post(url).json(body).timeout(std::time::Duration::from_secs(15)).send().await?.status())
}

/// A build with neither the app nor the server knows no site, so it sends nothing.
#[cfg(not(any(feature = "serve", feature = "desktop")))]
async fn send(_: &Value) -> Result<reqwest::StatusCode, reqwest::Error> {
    Ok(reqwest::StatusCode::OK)
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
    fn ready_to_merge_names_the_task() {
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
        assert_eq!(a["body"], "Ready to merge");
    }

    #[test]
    fn only_a_question_its_buttons_answer_whole_gets_them() {
        let ask = |multi_select: bool, label: &str| AgentEventPayload::QuestionsAsked {
            request_id: "r".into(),
            tool_use_id: "t".into(),
            questions: vec![crate::events::Question {
                question: "Which color?".into(),
                header: None,
                multi_select,
                options: ["Red", label].iter().map(|l| crate::events::QuestionOption { label: (*l).into(), description: None, preview: None }).collect(),
                free_text: true,
            }],
        };
        assert!(alert(&ask(false, "Green"), None).unwrap()["question"].is_object());
        assert!(alert(&ask(true, "Green"), None).unwrap()["question"].is_null());
        assert!(alert(&ask(false, &"g".repeat(61)), None).unwrap()["question"].is_null());
    }

    #[test]
    fn a_phone_saved_before_kinds_hears_everything() {
        let phones: Vec<Phone> = serde_json::from_str(r#"[{"handle":"dph_x","tag":"t"}]"#).unwrap();
        assert!(phones[0].off.is_empty());
    }
}
