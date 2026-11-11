//! What an assistant can do here. Starting and messaging go through the same
//! path as `dray session new` and `send` ([`orchestration::answer_here`]), so a
//! session started from a chat gets its worktree, its defaults and its sidebar
//! row exactly as one started by an agent does.

use std::time::{Duration, Instant};

use dray_proto::{CreateSession, Request, Response, SendMessage, SessionRef};
use serde_json::{json, Value};

use super::auth::Access;
use crate::{orchestration, serve, sink::Sink, store};

/// Under the ~100s at which edges and clients drop a request that has sent
/// nothing; T3 Code splits its waits at the same mark for the same reason.
const MAX_WAIT: u64 = 50;
/// The most of an agent's reply one read hands back. A turn's text can run to
/// pages, and the assistant's own context pays for every character.
const REPLY_CHARS: usize = 6000;
const LIST_LIMIT: usize = 30;

/// Every tool, and whether a read-only grant may call it.
fn catalog() -> Vec<(bool, Value)> {
    let read = json!({ "readOnlyHint": true, "openWorldHint": false });
    let write = json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false });
    let session_id = json!({ "type": "string", "description": "The session's id, from list_sessions or start_session." });
    vec![
        (true, json!({
            "name": "list_projects",
            "title": "List projects",
            "description": "The git repositories Dray works in on this machine. start_session takes one of these, by name or path.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read,
        })),
        (true, json!({
            "name": "list_sessions",
            "title": "List sessions",
            "description": "Recent coding-agent sessions on this machine, newest first: id, title, project, branch and status (in_progress, completed = finished and unread, idle). waiting=true means the agent is blocked on a question or permission for the user.",
            "inputSchema": { "type": "object", "properties": {
                "project": { "type": "string", "description": "Only this project, by name or path." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "How many, 30 by default." },
            } },
            "annotations": read,
        })),
        (true, json!({
            "name": "read_session",
            "title": "Read a session",
            "description": "Where a session stands: its status, the latest prompt, what the agent has said since, and any open card (a permission or question the agent is blocked on, with the options answer_card takes).",
            "inputSchema": { "type": "object", "properties": { "session_id": session_id }, "required": ["session_id"] },
            "annotations": read,
        })),
        (true, json!({
            "name": "wait_for_session",
            "title": "Wait for a session",
            "description": "Waits up to 50 seconds for a running session to finish or to need the user, then answers what read_session does. timed_out=true means it is still working: call again to keep waiting.",
            "inputSchema": { "type": "object", "properties": {
                "session_id": session_id,
                "seconds": { "type": "integer", "minimum": 1, "maximum": MAX_WAIT, "description": "How long to wait, 45 by default." },
            }, "required": ["session_id"] },
            "annotations": read,
        })),
        (false, json!({
            "name": "start_session",
            "title": "Start a session",
            "description": "Starts a coding agent on a task, in its own git worktree and branch of the project. Returns at once; follow it with wait_for_session. The agent may stop to ask permission: wait_for_session reports the open card, which you ask the user about and answer with answer_card.",
            "inputSchema": { "type": "object", "properties": {
                "prompt": { "type": "string", "description": "The task, written as you would brief an engineer." },
                "project": { "type": "string", "description": "Project name or path from list_projects. May be left out when there is only one." },
                "harness": { "type": "string", "description": "Which agent: claude_code, codex, pi, fx or grok. The machine's default when left out." },
                "model": { "type": "string", "description": "A model the harness takes. Its default when left out." },
                "title": { "type": "string", "description": "A short title for the sidebar. Generated when left out." },
            }, "required": ["prompt"] },
            "annotations": write,
        })),
        (false, json!({
            "name": "send_message",
            "title": "Message a session",
            "description": "Sends a follow-up to a session. Starts a turn when it is idle; queued until the current turn ends when it is running.",
            "inputSchema": { "type": "object", "properties": {
                "session_id": session_id,
                "message": { "type": "string" },
            }, "required": ["session_id", "message"] },
            "annotations": write,
        })),
        (false, json!({
            "name": "stop_session",
            "title": "Stop a session",
            "description": "Stops the session's running turn. The session stays and can be messaged again.",
            "inputSchema": { "type": "object", "properties": { "session_id": session_id }, "required": ["session_id"] },
            "annotations": json!({ "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false }),
        })),
        (false, json!({
            "name": "answer_card",
            "title": "Answer a card",
            "description": "Answers what a session is blocked on, from the open card read_session or wait_for_session reported. A permission takes option_id, one of the card's options. Questions take answers: each question's text mapped to the chosen option's label, several labels comma-separated for multi-select, or free text. Ask the user first; do not decide for them.",
            "inputSchema": { "type": "object", "properties": {
                "session_id": session_id,
                "request_id": { "type": "string", "description": "The card's request_id." },
                "option_id": { "type": "string", "description": "For a permission: the chosen option's id." },
                "answers": { "type": "object", "additionalProperties": { "type": "string" }, "description": "For questions: question text → answer." },
            }, "required": ["session_id", "request_id"] },
            "annotations": write,
        })),
    ]
}

/// The tools a grant sees: a read-only one is never shown what it cannot call.
pub fn list(access: Access) -> Vec<Value> {
    catalog().into_iter().filter(|(read, _)| *read || access == Access::Full).map(|(_, tool)| tool).collect()
}

/// `tools/call`. A tool's own failure is a result with `isError`, so the
/// model reads it and can try again; only a malformed call is a protocol error.
pub async fn call(params: &Value, access: Access, sink: &Sink) -> Value {
    let name = params["name"].as_str().unwrap_or_default();
    let args = &params["arguments"];
    let Some((read, _)) = catalog().into_iter().find(|(_, t)| t["name"] == name) else {
        return failed(format!("no tool {name}"));
    };
    if !read && access != Access::Full {
        return failed("This assistant was connected read-only. Connect it again with full access to change sessions.".into());
    }
    match run(name, args, sink).await {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default() }],
            "structuredContent": value,
        }),
        Err(why) => failed(why),
    }
}

async fn run(name: &str, args: &Value, sink: &Sink) -> Result<Value, String> {
    match name {
        "list_projects" => list_projects().await,
        "list_sessions" => list_sessions(args).await,
        "read_session" => read_session(text(args, "session_id")?).await,
        "wait_for_session" => wait_for_session(text(args, "session_id")?, args["seconds"].as_u64()).await,
        "start_session" => start_session(args, sink).await,
        "send_message" => send_message(text(args, "session_id")?, text(args, "message")?, sink).await,
        "stop_session" => stop_session(text(args, "session_id")?, sink).await,
        "answer_card" => answer_card(args, sink).await,
        _ => Err(format!("no tool {name}")),
    }
}

fn failed(why: String) -> Value {
    json!({ "content": [{ "type": "text", "text": why }], "isError": true })
}

/// A required string argument, or an error naming it.
fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args[key].as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| format!("{key} is required"))
}

async fn projects() -> Result<Vec<crate::projects::Project>, String> {
    crate::projects::list_projects().await.map_err(|e| format!("{:#}", anyhow::Error::from(e)))
}

async fn list_projects() -> Result<Value, String> {
    let projects = projects().await?;
    Ok(json!({ "projects": projects.iter().map(|p| json!({ "name": p.name, "path": p.path })).collect::<Vec<_>>() }))
}

/// A project named by path, by name, or by its folder's name.
async fn resolve_project(asked: Option<&str>) -> Result<String, String> {
    let projects = projects().await?;
    let Some(asked) = asked.map(str::trim).filter(|a| !a.is_empty()) else {
        return match projects.as_slice() {
            [only] => Ok(only.path.clone()),
            [] => Err("No projects on this machine yet. Add one in Dray first.".into()),
            _ => Err(format!(
                "Which project? One of: {}",
                projects.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")
            )),
        };
    };
    let folder = |p: &str| std::path::Path::new(p).file_name().map(|f| f.to_string_lossy().to_lowercase());
    projects
        .iter()
        .find(|p| p.path == asked)
        .or_else(|| projects.iter().find(|p| p.name.eq_ignore_ascii_case(asked)))
        .or_else(|| projects.iter().find(|p| folder(&p.path) == Some(asked.to_lowercase())))
        .map(|p| p.path.clone())
        .ok_or_else(|| {
            format!(
                "No project {asked}. One of: {}",
                projects.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")
            )
        })
}

fn waiting(asks: &[Value], session_id: &str) -> bool {
    asks.iter().any(|a| a["sessionId"] == session_id)
}

fn status_of(item: &store::SessionIndexItem) -> String {
    serde_json::to_value(item.status).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

async fn list_sessions(args: &Value) -> Result<Value, String> {
    let project = match args["project"].as_str() {
        Some(p) => Some(resolve_project(Some(p)).await?),
        None => None,
    };
    let limit = args["limit"].as_u64().map_or(LIST_LIMIT, |l| l.clamp(1, 100) as usize);
    let mut items = store::list_session_index_items(false).await.map_err(|e| format!("{:#}", anyhow::Error::from(e)))?;
    items.retain(|i| !i.hidden && project.as_deref().is_none_or(|p| i.project_path == p));
    items.sort_by(|a, b| b.modified.cmp(&a.modified));
    let asks = serve::open_asks();
    let sessions: Vec<Value> = items
        .iter()
        .take(limit)
        .map(|i| {
            json!({
                "session_id": i.session_id,
                "title": i.title,
                "status": status_of(i),
                "waiting": waiting(&asks, &i.session_id),
                "project": i.project_path,
                "branch": i.branch,
                "harness": i.harness,
                "modified": i.modified,
            })
        })
        .collect();
    Ok(json!({ "sessions": sessions }))
}

/// The cards a session is blocked on, in the shape `answer_card` takes back.
fn cards(asks: &[Value], session_id: &str) -> Vec<Value> {
    asks.iter()
        .filter(|a| a["sessionId"] == session_id)
        .map(|a| {
            let p = &a["payload"];
            if p["type"] == "questions_asked" {
                json!({
                    "request_id": p["requestId"],
                    "kind": "questions",
                    "questions": p["questions"].as_array().into_iter().flatten().map(|q| json!({
                        "question": q["question"],
                        "multi_select": q["multiSelect"],
                        "options": q["options"].as_array().into_iter().flatten().map(|o| o["label"].clone()).collect::<Vec<_>>(),
                    })).collect::<Vec<_>>(),
                })
            } else {
                let input = p["input"].to_string();
                json!({
                    "request_id": p["requestId"],
                    "kind": "permission",
                    "tool": p["displayName"].as_str().or(p["toolName"].as_str()),
                    "title": p["title"],
                    "description": p["description"],
                    "input": input.chars().take(1500).collect::<String>(),
                    "options": p["options"].as_array().into_iter().flatten().map(|o| json!({
                        "option_id": o["id"], "label": o["label"],
                    })).collect::<Vec<_>>(),
                })
            }
        })
        .collect()
}

async fn read_session(session_id: &str) -> Result<Value, String> {
    let snapshot = store::get_session_by_id(session_id, Some(2))
        .await
        .map_err(|e| format!("{:#}", anyhow::Error::from(e)))?
        .ok_or_else(|| format!("no session {session_id} on this machine"))?;
    let item = &snapshot.index_item;
    // The main thread alone: a subagent's chatter is not the session's answer.
    let events: Vec<Value> = snapshot
        .events
        .iter()
        .filter(|e| e.subagent.is_none())
        .filter_map(|e| serde_json::to_value(&e.payload).ok())
        .collect();
    let last_prompt = events.iter().rposition(|p| p["type"] == "user_message");
    let since = &events[last_prompt.map_or(0, |i| i + 1)..];
    let reply: String = since
        .iter()
        .filter(|p| p["type"] == "assistant_text")
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let skip = reply.chars().count().saturating_sub(REPLY_CHARS);
    let reply = if skip > 0 { format!("…{}", reply.chars().skip(skip).collect::<String>()) } else { reply };
    let tools: Vec<&str> = since
        .iter()
        .filter(|p| p["type"] == "tool_call_started")
        .filter_map(|p| p["name"].as_str())
        .collect();
    let turn = since.iter().rev().find(|p| p["type"] == "turn_completed").map(turn_outcome);
    let asks = serve::open_asks();
    Ok(json!({
        "session_id": item.session_id,
        "title": item.title,
        "status": status_of(item),
        "project": item.project_path,
        "branch": item.branch,
        "harness": item.harness,
        "model": item.model,
        "last_prompt": last_prompt.and_then(|i| events[i]["text"].as_str()),
        "reply": reply,
        "tool_calls": tools.len(),
        "turn": turn,
        "open_cards": cards(&asks, session_id),
    }))
}

/// How a turn ended, in the words a model should read. A Stop the user asked
/// for closes as an error on Claude's wire (`aborted_*`) and as a success on
/// Codex's (`interrupted`) and fx's and Grok's (`cancelled`); reported raw, the
/// first reads as a crash and the rest as work done.
fn turn_outcome(turn: &Value) -> Value {
    let reason = turn["stopReason"].as_str().unwrap_or_default();
    if reason.starts_with("aborted") || matches!(reason, "interrupted" | "cancelled") {
        return json!({ "outcome": "stopped", "note": "Stopped on request. Send a message to carry on." });
    }
    if turn["status"] == "error" {
        let why = turn["finalText"].as_str().filter(|t| !t.trim().is_empty()).unwrap_or("The turn failed.");
        return json!({ "outcome": "failed", "error": why });
    }
    json!({ "outcome": "finished" })
}

async fn wait_for_session(session_id: &str, seconds: Option<u64>) -> Result<Value, String> {
    let limit = Duration::from_secs(seconds.unwrap_or(45).clamp(1, MAX_WAIT));
    let started = Instant::now();
    loop {
        let item = store::get_session_index_item(session_id)
            .await
            .map_err(|e| format!("{e:#}"))?
            .ok_or_else(|| format!("no session {session_id} on this machine"))?;
        // A send moments ago can still read idle; give it a beat to start.
        let settled = status_of(&item) != "in_progress" && started.elapsed() > Duration::from_secs(3);
        if settled || waiting(&serve::open_asks(), session_id) {
            break;
        }
        if started.elapsed() >= limit {
            let mut answer = read_session(session_id).await?;
            answer["timed_out"] = json!(true);
            return Ok(answer);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let mut answer = read_session(session_id).await?;
    answer["timed_out"] = json!(false);
    Ok(answer)
}

async fn orchestrate(request: Request, sink: &Sink) -> Result<Response, String> {
    match orchestration::answer_here(request, sink).await {
        Response::Error { message } => Err(message),
        answer => Ok(answer),
    }
}

async fn start_session(args: &Value, sink: &Sink) -> Result<Value, String> {
    let project = resolve_project(args["project"].as_str()).await?;
    let create = CreateSession {
        prompt: text(args, "prompt")?.to_string(),
        project_path: Some(project),
        harness: args["harness"].as_str().map(str::to_string),
        model: args["model"].as_str().map(str::to_string),
        title: args["title"].as_str().map(str::to_string),
        ..Default::default()
    };
    match orchestrate(Request::CreateSession(create), sink).await? {
        Response::Created { session, .. } => Ok(json!({
            "session_id": session.session_id,
            "title": session.title,
            "branch": session.branch,
            // The summary is taken from the index before the tracker flips it,
            // so it reads idle; the prompt has gone out and a turn is running.
            "status": "in_progress",
            "next": "Call wait_for_session with this session_id to follow it.",
        })),
        other => Err(format!("unexpected answer: {other:?}")),
    }
}

async fn send_message(session_id: &str, message: &str, sink: &Sink) -> Result<Value, String> {
    let send = SendMessage { session_id: session_id.into(), prompt: message.into(), from_session_id: None };
    match orchestrate(Request::SendMessage(send), sink).await? {
        Response::Sent { queued } => Ok(json!({ "sent": true, "queued": queued })),
        other => Err(format!("unexpected answer: {other:?}")),
    }
}

async fn stop_session(session_id: &str, sink: &Sink) -> Result<Value, String> {
    orchestrate(Request::StopSession(SessionRef { session_id: session_id.into() }), sink).await?;
    Ok(json!({ "stopped": true }))
}

async fn answer_card(args: &Value, sink: &Sink) -> Result<Value, String> {
    let session_id = text(args, "session_id")?;
    let request_id = text(args, "request_id")?;
    let manager = crate::session::manager();
    let answered = if let Some(option) = args["option_id"].as_str() {
        manager.respond_permission(session_id, request_id, option, sink).await
    } else if let Some(answers) = args["answers"].as_object() {
        let answers = answers.iter().filter_map(|(q, a)| Some((q.clone(), a.as_str()?.to_string()))).collect();
        manager.answer_questions(session_id, request_id, answers, sink).await
    } else {
        return Err("Give option_id for a permission, or answers for questions.".into());
    };
    answered.map_err(|e| format!("{e:#}"))?;
    Ok(json!({ "answered": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stop_reads_as_stopped_never_as_a_crash() {
        let claude = json!({ "type": "turn_completed", "status": "error", "stopReason": "aborted_tools", "finalText": null });
        assert_eq!(turn_outcome(&claude)["outcome"], "stopped");
        let codex = json!({ "type": "turn_completed", "status": "success", "stopReason": "interrupted" });
        assert_eq!(turn_outcome(&codex)["outcome"], "stopped");
        let fx_or_grok = json!({ "type": "turn_completed", "status": "success", "stopReason": "cancelled" });
        assert_eq!(turn_outcome(&fx_or_grok)["outcome"], "stopped");
    }

    #[test]
    fn a_failure_always_says_why() {
        let bare = json!({ "type": "turn_completed", "status": "error", "stopReason": "stop_sequence", "finalText": null });
        assert_eq!(turn_outcome(&bare), json!({ "outcome": "failed", "error": "The turn failed." }));
        let said = json!({ "type": "turn_completed", "status": "error", "finalText": "Credit balance is too low" });
        assert_eq!(turn_outcome(&said)["error"], "Credit balance is too low");
        assert_eq!(turn_outcome(&json!({ "status": "success" }))["outcome"], "finished");
    }
}
