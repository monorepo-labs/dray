//! Remote MCP: every Dray server answers the Model Context Protocol at
//! `/mcp`, on the listener the app's WebSocket uses and so at Remote access's
//! public address, letting Grok Bot, Claude or ChatGPT start and follow
//! sessions here (#858). Sign-in is OAuth with a pairing code ([`auth`]); the
//! tools are in [`tools`]. See MCP-PLAN.md.
//!
//! Streamable HTTP in its plainest form: each POST answered with one JSON
//! body, no session id and no SSE stream, since nothing here is pushed and a
//! stateless server survives a restart mid-conversation.

mod auth;
mod tools;

use std::convert::Infallible;

use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Bytes, header, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use tokio::net::TcpStream;

pub use auth::{assistants, pair, revoke, AssistantSummary, Pairing, CHANGED};

use crate::sink::Sink;

/// Protocol revisions this server speaks, newest first. Only the transport
/// changed shape across them, and nothing here uses what changed.
const VERSIONS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];
const BODY_LIMIT: usize = 1 << 20;
/// Bounds a whole connection: `wait_for_session` holds a request for 50s.
const CONNECTION_LIFE: std::time::Duration = std::time::Duration::from_secs(120);

/// Whether a request line belongs here rather than to the WebSocket.
pub fn routes(line: &str) -> bool {
    let target = line.split(' ').nth(1).unwrap_or_default();
    let path = target.split('?').next().unwrap_or_default();
    path == "/mcp" || path.starts_with("/.well-known/oauth-") || path.starts_with("/oauth/")
}

/// Serves one connection. Not kept alive: each request is a fresh connect, so
/// an idle client holds no task in the listener's set.
pub async fn serve(stream: TcpStream, sink: Sink) -> anyhow::Result<()> {
    let service = hyper::service::service_fn(move |req| {
        let sink = sink.clone();
        async move { Ok::<_, Infallible>(handle(req, sink).await) }
    });
    let connection = hyper::server::conn::http1::Builder::new()
        .keep_alive(false)
        .serve_connection(TokioIo::new(stream), service);
    tokio::time::timeout(CONNECTION_LIFE, connection).await.map_err(|_| anyhow::anyhow!("mcp connection timed out"))??;
    Ok(())
}

type Answer = Response<Full<Bytes>>;

fn reply(status: u16, content_type: &str, body: impl Into<Bytes>) -> Answer {
    let mut answer = Response::new(Full::new(body.into()));
    *answer.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    if !content_type.is_empty() {
        answer.headers_mut().insert(header::CONTENT_TYPE, content_type.parse().expect("static header"));
    }
    answer.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().expect("static header"));
    answer
}

fn json_reply(status: u16, body: &Value) -> Answer {
    reply(status, "application/json", body.to_string())
}

/// This server's own origin as the client reached it. Behind Remote access the
/// tunnel ends TLS in this process and passes the public `Host` through, and
/// the OAuth `resource` must equal the URL the reader pasted, so the origin is
/// read off each request rather than stored.
fn base_url(req: &Request<hyper::body::Incoming>) -> String {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("127.0.0.1");
    let local = ["localhost", "127.0.0.1", "[::1]"]
        .iter()
        .any(|l| host.strip_prefix(l).is_some_and(|rest| rest.is_empty() || rest.starts_with(':')));
    format!("{}://{host}", if local { "http" } else { "https" })
}

async fn body(req: Request<hyper::body::Incoming>) -> Option<Bytes> {
    Limited::new(req.into_body(), BODY_LIMIT).collect().await.ok().map(|b| b.to_bytes())
}

async fn handle(req: Request<hyper::body::Incoming>, sink: Sink) -> Answer {
    let base = base_url(&req);
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or_default().to_string();
    let bearer = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(str::to_string);
    match (req.method().clone(), path.as_str()) {
        (Method::GET, "/.well-known/oauth-protected-resource" | "/.well-known/oauth-protected-resource/mcp") => {
            json_reply(200, &auth::resource_metadata(&base))
        }
        (Method::GET, "/.well-known/oauth-authorization-server" | "/.well-known/oauth-authorization-server/mcp") => {
            json_reply(200, &auth::server_metadata(&base))
        }
        (Method::POST, "/oauth/register") => match body(req).await {
            Some(bytes) => {
                let (status, answer) = auth::register(&bytes).await;
                json_reply(status, &answer)
            }
            None => json_reply(413, &json!({ "error": "invalid_request" })),
        },
        (Method::GET, "/oauth/authorize") => {
            let (ask, _) = auth::AuthorizeAsk::from_pairs(form_urlencoded::parse(query.as_bytes()));
            page(auth::authorize_page(&ask).await, &query)
        }
        (Method::POST, "/oauth/authorize") => {
            let Some(bytes) = body(req).await else { return json_reply(413, &json!({ "error": "invalid_request" })) };
            let (ask, typed) = auth::AuthorizeAsk::from_pairs(form_urlencoded::parse(&bytes));
            let echoed: String = form_urlencoded::Serializer::new(String::new())
                .extend_pairs(form_urlencoded::parse(&bytes).filter(|(k, _)| k != "pairing_code"))
                .finish();
            page(auth::authorize(&ask, typed.as_deref().unwrap_or_default()).await, &echoed)
        }
        (Method::POST, "/oauth/token") => match body(req).await {
            Some(bytes) => {
                let (status, answer) = auth::token(&bytes, &sink).await;
                json_reply(status, &answer)
            }
            None => json_reply(413, &json!({ "error": "invalid_request" })),
        },
        (Method::POST, "/mcp") => {
            let Some(access) = bearer.as_deref().and_then(auth::check) else {
                // The pointer is what starts sign-in: Claude ignores it on
                // anything but a 401.
                let mut answer = json_reply(401, &json!({ "error": "invalid_token" }));
                let challenge = format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\"");
                answer.headers_mut().insert(header::WWW_AUTHENTICATE, challenge.parse().expect("ascii header"));
                return answer;
            };
            match body(req).await {
                Some(bytes) => rpc(&bytes, access, &sink).await,
                None => json_reply(413, &rpc_error(Value::Null, -32600, "request too large")),
            }
        }
        // No server-sent stream and no sessions to end: both are optional.
        (Method::GET | Method::DELETE, "/mcp") => {
            let mut answer = reply(405, "", "");
            answer.headers_mut().insert(header::ALLOW, "POST".parse().expect("static header"));
            answer
        }
        _ => reply(404, "", ""),
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn rpc(bytes: &[u8], access: auth::Access, sink: &Sink) -> Answer {
    let Ok(message) = serde_json::from_slice::<Value>(bytes) else {
        return json_reply(400, &rpc_error(Value::Null, -32700, "parse error"));
    };
    // A batch is 2025-03-26's alone; answered in case an older client sends one.
    let answer = match message {
        Value::Array(batch) => {
            let mut answers = Vec::new();
            for one in batch {
                answers.extend(answer(one, access, sink).await);
            }
            (!answers.is_empty()).then_some(Value::Array(answers))
        }
        one => answer(one, access, sink).await,
    };
    match answer {
        Some(answer) => json_reply(200, &answer),
        // A notification or a response: accepted, nothing to say.
        None => reply(202, "", ""),
    }
}

async fn answer(message: Value, access: auth::Access, sink: &Sink) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let method = message.get("method")?.as_str().unwrap_or_default();
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match method {
        "initialize" => initialize(&params),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools::list(access) }),
        "tools/call" => tools::call(&params, access, sink).await,
        _ => return Some(rpc_error(id, -32601, &format!("method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn initialize(params: &Value) -> Value {
    let asked = params["protocolVersion"].as_str().unwrap_or_default();
    let version = VERSIONS.iter().find(|v| **v == asked).unwrap_or(&VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "dray", "title": "Dray", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Dray runs coding agents (Claude Code, Codex and others) on this machine. \
            start_session gives a task to an agent in its own git worktree and returns at once; \
            follow it with wait_for_session, calling again while timed_out is true. When a session \
            reports an open card, the agent is blocked on the user: ask the user, then answer with \
            answer_card. Never answer a card on the user's behalf.",
    })
}

/// The sign-in page, or where it sends the browser.
fn page(page: auth::Page, query: &str) -> Answer {
    match page {
        auth::Page::Redirect(target) => {
            let mut answer = reply(302, "", "");
            match target.parse() {
                Ok(location) => {
                    answer.headers_mut().insert(header::LOCATION, location);
                    answer
                }
                Err(_) => html(400, &refused("The address this sign-in returns to is not one a browser can open.")),
            }
        }
        auth::Page::Refused(why) => html(400, &refused(&why)),
        auth::Page::Ask { client, redirect_host, error } => html(if error.is_some() { 401 } else { 200 }, &ask(&client, &redirect_host, error, query)),
    }
}

fn html(status: u16, body: &str) -> Answer {
    let mut answer = reply(status, "text/html; charset=utf-8", body.to_string());
    // The page is the one thing here a browser renders, so it may not be
    // framed. No `form-action`: Chrome applies it to the redirect after the
    // post, and `*` does not cover `cursor://` or a loopback port.
    answer.headers_mut().insert("x-frame-options", "DENY".parse().expect("static header"));
    answer.headers_mut().insert(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'".parse().expect("static header"),
    );
    answer
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

const STYLE: &str = "\
:root{color-scheme:light dark;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e2e2e2;--bg:#fafafa;--card:#fff;--accent:#f5c518}\
@media(prefers-color-scheme:dark){:root{--fg:#ededed;--muted:#9a9a9a;--line:#2e2e2e;--bg:#111;--card:#1a1a1a}}\
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);\
font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}\
main{width:min(380px,calc(100vw - 32px));background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}\
h1{font-size:16px;margin:0 0 6px}p{margin:0 0 14px;color:var(--muted)}b{color:var(--fg);font-weight:600}\
input{width:100%;font:600 20px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;text-align:center;\
padding:12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg);margin-bottom:12px}\
button{width:100%;padding:10px;border:0;border-radius:10px;background:var(--accent);color:#1a1a1a;font:inherit;font-weight:600;cursor:pointer;\
box-shadow:0 1px 2px rgba(0,0,0,.15)}.error{color:#d14343}.small{font-size:12px;margin:12px 0 0}";

fn ask(client: &str, redirect_host: &str, error: Option<&str>, query: &str) -> String {
    let machine = escape(&dray_proto::machine_name());
    let hidden: String = form_urlencoded::parse(query.as_bytes())
        .filter(|(k, _)| k != "pairing_code")
        .map(|(k, v)| format!("<input type=\"hidden\" name=\"{}\" value=\"{}\">", escape(&k), escape(&v)))
        .collect();
    let error = error.map(|e| format!("<p class=\"error\">{}</p>", escape(e))).unwrap_or_default();
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>Connect to Dray</title><style>{STYLE}</style></head><body><main>\
         <h1>Connect {client} to Dray on {machine}</h1>\
         <p>It will be able to list, start, message and stop coding sessions on this machine.</p>{error}\
         <form method=\"post\" action=\"/oauth/authorize\">{hidden}\
         <input name=\"pairing_code\" placeholder=\"ABCD-EFGH\" autocomplete=\"off\" autocapitalize=\"characters\" spellcheck=\"false\" autofocus required>\
         <button type=\"submit\">Connect</button></form>\
         <p class=\"small\">Get a code in Dray: Settings, Servers, Connect an assistant. Or run <b>dray server assistant add</b>. \
         Sends you back to <b>{redirect}</b>.</p></main></body></html>",
        client = escape(client),
        redirect = escape(redirect_host),
    )
}

fn refused(why: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>Connect to Dray</title><style>{STYLE}</style></head><body><main><h1>Can't connect</h1><p>{}</p></main></body></html>",
        escape(why)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_mcp_and_oauth_paths_are_routed_here() {
        assert!(routes("POST /mcp HTTP/1.1"));
        assert!(routes("GET /.well-known/oauth-protected-resource/mcp HTTP/1.1"));
        assert!(routes("GET /oauth/authorize?client_id=x HTTP/1.1"));
        assert!(!routes("GET / HTTP/1.1"), "the WebSocket upgrade");
        assert!(!routes("GET /mcpx HTTP/1.1"));
        assert!(!routes("GET /file?path=%2Fmcp HTTP/1.1"));
    }

    #[test]
    fn a_version_the_client_asks_for_is_echoed_when_spoken() {
        assert_eq!(initialize(&json!({ "protocolVersion": "2025-06-18" }))["protocolVersion"], "2025-06-18");
        assert_eq!(initialize(&json!({ "protocolVersion": "1999-01-01" }))["protocolVersion"], VERSIONS[0]);
    }

    #[test]
    fn a_read_only_grant_is_never_shown_a_tool_that_changes_anything() {
        let read: Vec<Value> = tools::list(auth::Access::Read);
        assert!(read.iter().all(|t| t["annotations"]["readOnlyHint"] == true));
        assert!(tools::list(auth::Access::Full).len() > read.len());
    }
}
