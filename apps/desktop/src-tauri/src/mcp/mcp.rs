//! Remote MCP: every Dray server answers the Model Context Protocol at
//! `/mcp`, on the listener the app's WebSocket uses and so at Remote access's
//! public address, letting Grok Bot, Claude or ChatGPT start and follow
//! sessions here (#858). Sign-in is this server's own OAuth ([`auth`]), the
//! reader proving who they are at drayhq.com ([`account`]) or with a pairing
//! code, and only on a server linked to an org; the tools are in [`tools`].
//! See MCP-PLAN.md.
//!
//! Streamable HTTP in its plainest form: each POST answered with one JSON
//! body, no session id and no SSE stream, since nothing here is pushed and a
//! stateless server survives a restart mid-conversation.

mod account;
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
    let port = stream.local_addr()?.port();
    let service = hyper::service::service_fn(move |req| {
        let sink = sink.clone();
        async move { Ok::<_, Infallible>(handle(req, sink, port).await) }
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

/// Where drayhq.com may send the browser back to: this server as it really
/// is, never as `Host` claims. A spoofed `Host` would otherwise send a signed
/// assertion to someone else's address, to be replayed here. Loopback keeps
/// its host but takes the port this listener is on; anything else must be
/// Remote access's own address.
fn return_base(base: &str, port: u16) -> Option<String> {
    if let Some(authority) = base.strip_prefix("http://") {
        // `base_url` writes `http` for loopback hosts alone.
        let host = if authority.starts_with('[') {
            authority.split_inclusive(']').next()?
        } else {
            authority.split(':').next()?
        };
        return Some(format!("http://{host}:{port}"));
    }
    let public = crate::remote_access::get_remote_access().address?.replacen("wss://", "https://", 1);
    let public = public.trim_end_matches('/');
    (base == public).then(|| public.to_string())
}

async fn body(req: Request<hyper::body::Incoming>) -> Option<Bytes> {
    Limited::new(req.into_body(), BODY_LIMIT).collect().await.ok().map(|b| b.to_bytes())
}

async fn handle(req: Request<hyper::body::Incoming>, sink: Sink, port: u16) -> Answer {
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
            page(auth::authorize_page(&ask, &sink).await, &query)
        }
        (Method::POST, "/oauth/authorize") => {
            let Some(bytes) = body(req).await else { return json_reply(413, &json!({ "error": "invalid_request" })) };
            let (ask, typed) = auth::AuthorizeAsk::from_pairs(form_urlencoded::parse(&bytes));
            let echoed: String = form_urlencoded::Serializer::new(String::new())
                .extend_pairs(form_urlencoded::parse(&bytes).filter(|(k, _)| !FORM_FIELDS.contains(&&**k)))
                .finish();
            let typed = typed.unwrap_or(auth::Typed::Code(String::new()));
            page(auth::authorize(&ask, typed, return_base(&base, port).as_deref(), &sink).await, &echoed)
        }
        (Method::GET, "/oauth/dray") => page(auth::dray_return(&query, &sink).await, ""),
        (Method::POST, "/oauth/token") => match body(req).await {
            Some(bytes) => {
                let (status, answer) = auth::token(&bytes, &sink).await;
                json_reply(status, &answer)
            }
            None => json_reply(413, &json!({ "error": "invalid_request" })),
        },
        (Method::POST, "/mcp") => {
            let Some((access, user)) = bearer.as_deref().and_then(auth::check) else { return unauthorized(&base) };
            match account::admit(&sink, user.as_deref()).await {
                account::Admit::Yes => {}
                // Not a 401: that would send the assistant to sign in again,
                // and a sign-in needs the site too.
                account::Admit::Unreachable => {
                    let why = "Can't reach drayhq.com to check this account's access. Try again in a minute.";
                    return json_reply(503, &rpc_error(Value::Null, -32000, why));
                }
                account::Admit::Unlinked | account::Admit::Refused => return unauthorized(&base),
            }
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

/// The sign-in page's own fields, never echoed back into its hidden inputs.
const FORM_FIELDS: [&str; 2] = ["pairing_code", "via"];

/// A `/mcp` call with no good token. The pointer is what starts sign-in:
/// Claude ignores it on anything but a 401.
fn unauthorized(base: &str) -> Answer {
    let mut answer = json_reply(401, &json!({ "error": "invalid_token" }));
    let challenge = format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\"");
    answer.headers_mut().insert(header::WWW_AUTHENTICATE, challenge.parse().expect("ascii header"));
    answer
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
        auth::Page::Unlinked => html(403, &unlinked()),
        auth::Page::Ask { client, redirect_host, site, error, pairing } => {
            let status = if error.is_some() { 401 } else { 200 };
            html(status, &ask(&client, &redirect_host, &site, error.as_deref(), pairing, query))
        }
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

/// drayhq.com's account pages in plain CSS: hairlines, mono uppercase labels,
/// one filled button. Inter where it is installed; nothing is fetched.
const STYLE: &str = "\
:root{color-scheme:dark;--fg:#fff;--bg:#000;--muted:#7C7C7C;--line:rgba(255,255,255,.2);--focus:rgba(255,255,255,.6);\
--fill:#fff;--on-fill:#0B0B0F;--hover:rgba(255,255,255,.1)}\
@media(prefers-color-scheme:light){:root{color-scheme:light;--fg:#0A0A0A;--bg:#F4F4F2;--muted:#8A8A8A;--line:rgba(0,0,0,.15);\
--focus:rgba(0,0,0,.5);--fill:#0A0A0A;--on-fill:#fff;--hover:rgba(0,0,0,.05)}}\
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;\
font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}\
main{max-width:604px;margin:0 auto;padding:40px 20px 120px}\
.label,summary,.secondary{font:11px/14px ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase}\
.label{color:var(--muted);margin:0}\
h1{margin:0;padding-top:64px;font-size:28px;line-height:32px;font-weight:400;letter-spacing:-.03em;text-wrap:balance}\
@media(min-width:640px){h1{padding-top:101px;font-size:36px;line-height:40px}}\
.lead{margin:16px 0 0;font-size:16px;line-height:24px;letter-spacing:-.01em;color:var(--muted)}\
b,code{color:var(--fg);font-weight:500}code{font:13px ui-monospace,Menlo,monospace}\
.primary{display:inline-flex;align-items:center;height:40px;padding:0 16px;border:0;border-radius:6px;background:var(--fill);\
color:var(--on-fill);font-family:inherit;font-size:14px;line-height:20px;font-weight:500;cursor:pointer;box-shadow:inset 0 -1px 0 #4D4C4C,0 1px 2px #00000040}\
.primary:hover{opacity:.9}\
.secondary{height:40px;padding:0 16px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer;flex-shrink:0}\
.secondary:hover{background:var(--hover)}\
.actions{margin-top:40px}\
details{margin-top:32px;border-top:1px solid var(--line);padding-top:20px}\
summary{color:var(--muted);cursor:pointer;width:max-content}summary:hover{color:var(--fg)}\
.row{display:flex;gap:8px;max-width:360px;margin-top:16px}\
input{height:40px;width:100%;padding:0 12px;border:1px solid var(--line);border-radius:0;background:transparent;color:var(--fg);outline:none;\
font:14px ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}input:focus{border-color:var(--focus)}\
input::placeholder{color:#5C5C5C}\
.error{margin:16px 0 0;font-size:13px;color:#FF5A4E}\
.small{margin:12px 0 0;font-size:13px;color:var(--muted)}.foot{margin-top:32px}";

fn document(body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>Connect to Dray</title><style>{STYLE}</style></head><body><main><p class=\"label\">Dray</p>{body}</main></body></html>"
    )
}

fn ask(client: &str, redirect_host: &str, site: &str, error: Option<&str>, pairing: bool, query: &str) -> String {
    let machine = escape(&dray_proto::machine_name());
    let hidden: String = form_urlencoded::parse(query.as_bytes())
        .filter(|(k, _)| !FORM_FIELDS.contains(&&**k))
        .map(|(k, v)| format!("<input type=\"hidden\" name=\"{}\" value=\"{}\">", escape(&k), escape(&v)))
        .collect();
    let error = error.map(|e| format!("<p class=\"error\">{}</p>", escape(e))).unwrap_or_default();
    let (open, focus) = if pairing { (" open", " autofocus") } else { ("", "") };
    document(&format!(
        "<h1>Connect {client} to Dray on {machine}.</h1>\
         <p class=\"lead\">It will be able to list, start, message and stop coding sessions on this machine. \
         Sign in with your Dray account to allow it.</p>{error}\
         <form class=\"actions\" method=\"post\" action=\"/oauth/authorize\">{hidden}<input type=\"hidden\" name=\"via\" value=\"dray\">\
         <button class=\"primary\" type=\"submit\">Continue with {site}</button></form>\
         <details{open}><summary>Use a pairing code</summary>\
         <form method=\"post\" action=\"/oauth/authorize\">{hidden}<div class=\"row\">\
         <input name=\"pairing_code\" placeholder=\"ABCD-EFGH\" aria-label=\"Pairing code\" autocomplete=\"off\" autocapitalize=\"characters\" \
         spellcheck=\"false\" maxlength=\"12\" required{focus}><button class=\"secondary\" type=\"submit\">Connect</button></div></form>\
         <p class=\"small\">Get a code in Dray: Settings, Servers, Connect an assistant. Or run <code>dray server assistant add</code>.</p>\
         </details>\
         <p class=\"small foot\">Sends you back to <b>{redirect}</b>.</p>",
        client = escape(client),
        site = escape(site),
        redirect = escape(redirect_host),
    ))
}

fn unlinked() -> String {
    document(&format!(
        "<h1>{} isn't linked to a Dray account.</h1>\
         <p class=\"lead\">Link it, then connect again: run <code>dray login</code> on it, or sign in from the Dray app.</p>",
        escape(&dray_proto::machine_name())
    ))
}

fn refused(why: &str) -> String {
    document(&format!("<h1>Can't connect.</h1><p class=\"lead\">{}</p>", escape(why)))
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
    fn the_return_address_is_this_server_not_what_host_says() {
        assert_eq!(return_base("http://127.0.0.1:9999", 47811).as_deref(), Some("http://127.0.0.1:47811"));
        assert_eq!(return_base("http://[::1]:1", 47811).as_deref(), Some("http://[::1]:47811"));
        assert_eq!(return_base("http://localhost", 47811).as_deref(), Some("http://localhost:47811"));
        assert_eq!(return_base("https://evil.test", 47811), None, "not Remote access's address");
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
