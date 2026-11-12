//! Just enough OAuth 2.1 for Grok Bot, Claude and ChatGPT to sign in to
//! `/mcp`. Who is signing in is settled at drayhq.com ([`super::account`]), or
//! by a pairing code standing in for a password; either only on a server
//! linked to an org. OAuth because it is
//! the one method all three take: Claude's static headers are a beta for org
//! Owners, Grok Bot's connectors are OAuth only, and a token in the URL is
//! forbidden by the spec and cannot be revoked per client.
//!
//! Registration is open (DCR) and every client is public, proving itself with
//! PKCE. What an assistant holds is a grant: listed, revocable, kept across
//! restarts in `mcp.json`. Access tokens live in memory alone, so a restart
//! costs a client one refresh, which every client does on a `401`.

use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use ts_rs::TS;

use super::account::{self, Admit, DrayUser};
use crate::{org_link, sink::Sink, store};

/// A pairing code is typed by hand, so it is short; this keeps a guess at it
/// short-lived too.
const PAIRING_LIFE: Duration = Duration::from_secs(10 * 60);
const CODE_LIFE: Duration = Duration::from_secs(5 * 60);
const ACCESS_LIFE: Duration = Duration::from_secs(60 * 60);
/// Rolling: every refresh moves it, so an assistant in use never signs out.
const REFRESH_DAYS: i64 = 30;
/// Wrong codes tolerated before every outstanding code is thrown away. With
/// ~39 bits a code, ten guesses are nothing, and a reader whose code died
/// mints another.
const MAX_FAILURES: u32 = 10;
/// Registered clients that never signed in, kept a day and then dropped.
/// Claude registers afresh on every new connection, so these pile up.
const IDLE_CLIENT_HOURS: i64 = 24;
/// Registration is open to anyone who reaches the address, so what it may
/// store is bounded three ways: per client, in count, and in rate. Past
/// [`MAX_PENDING`] the oldest clients that never signed in make room.
const MAX_REDIRECTS: usize = 10;
const MAX_REDIRECT_LEN: usize = 2048;
const MAX_PENDING: usize = 100;
const REGISTRATIONS_PER_MINUTE: usize = 20;
/// Unambiguous when read off a screen: no 0/O, 1/I/L, U.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTVWXYZ23456789";

pub const CHANGED: &str = "mcp_assistants_changed";

/// What an assistant may do. Chosen when the code is made, carried by the
/// grant for its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Full,
    Read,
}

/// One connected assistant, as Settings → Servers and `dray server assistant
/// ls` list it.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct AssistantSummary {
    pub id: String,
    /// What the client called itself when it registered: "Claude", "Grok".
    pub name: String,
    pub access: Access,
    pub created: String,
    /// Moves on each token refresh, so it is right to the hour.
    pub last_used: String,
    /// The Dray account it signed in with at drayhq.com; none for a pairing code.
    pub user: Option<String>,
}

/// A code waiting to be typed into an assistant's sign-in page.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    /// The MCP URL to paste into the assistant.
    pub url: String,
    /// `ABCD-EFGH`.
    pub code: String,
    pub expires_in_secs: u64,
    pub access: Access,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Client {
    id: String,
    #[serde(default)]
    name: Option<String>,
    redirect_uris: Vec<String>,
    created: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    id: String,
    client_id: String,
    name: String,
    access: Access,
    created: String,
    last_used: String,
    /// The refresh token's hash, never the token.
    refresh: String,
    expires: String,
    /// Who signed it in at drayhq.com, asked about again on every call.
    #[serde(default)]
    user: Option<DrayUser>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Book {
    #[serde(default)]
    clients: Vec<Client>,
    #[serde(default)]
    grants: Vec<Grant>,
}

struct Code {
    client_id: String,
    redirect_uri: String,
    challenge: String,
    access: Access,
    user: Option<DrayUser>,
    born: Instant,
}

/// An access token's grant, what it may do, and whose it is.
struct Live {
    grant: String,
    access: Access,
    user: Option<String>,
    born: Instant,
}

#[derive(Default)]
struct Memory {
    pairings: HashMap<String, (Access, Instant)>,
    failures: u32,
    /// Keyed by the code's hash, like everything a client holds.
    codes: HashMap<String, Code>,
    access: HashMap<String, Live>,
    registrations: std::collections::VecDeque<Instant>,
}

static MEMORY: LazyLock<Mutex<Memory>> = LazyLock::new(Default::default);
/// Held across a read-change-write of `mcp.json`.
static BOOK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn memory() -> std::sync::MutexGuard<'static, Memory> {
    MEMORY.lock().unwrap_or_else(|e| e.into_inner())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn hash(secret: &str) -> String {
    sha2::Sha256::digest(secret.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn secret(prefix: &str) -> String {
    format!("{prefix}{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

async fn book_path() -> Result<std::path::PathBuf> {
    Ok(store::get_home_app_dir().await?.join("mcp.json"))
}

/// An unreadable file reads as empty: every assistant signs in again, which
/// beats a server that can no longer answer `/mcp` at all.
async fn read_book() -> Result<Book> {
    let path = book_path().await?;
    Ok(match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Book::default(),
        Err(e) => return Err(e).with_context(|| format!("could not read {}", path.display())),
    })
}

async fn write_book(book: &Book) -> Result<()> {
    let path = book_path().await?;
    let bytes = serde_json::to_vec_pretty(book)?;
    store::write_private_atomic(&path, &bytes).with_context(|| format!("could not write {}", path.display()))
}

/// Mints a pairing code for an assistant to sign in with, turning Remote
/// access on first if it is off, since that address is the only one an
/// assistant's cloud can reach. `replaces` is a code this one stands in for,
/// which dies now rather than in ten minutes: switching a dialog to read-only
/// must not leave its full-access code good.
pub async fn pair(sink: Sink, read_only: bool, replaces: Option<String>) -> Result<Pairing, String> {
    if let Some(old) = replaces {
        memory().pairings.remove(&normalize(&old));
    }
    if !crate::remote_access::get_remote_access().on {
        crate::remote_access::set_remote_access(sink, true).await?;
    }
    // A first start provisions a certificate, which has taken minutes.
    let deadline = Instant::now() + Duration::from_secs(150);
    let address = loop {
        let now = crate::remote_access::get_remote_access();
        if let Some(address) = now.address {
            break address;
        }
        if !now.on {
            return Err("Remote access was turned off.".into());
        }
        if Instant::now() > deadline {
            return Err(now.error.unwrap_or_else(|| "Remote access is still starting. Try again in a minute.".into()));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    let access = if read_only { Access::Read } else { Access::Full };
    let raw: String = uuid::Uuid::new_v4()
        .as_bytes()
        .iter()
        .take(8)
        .map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char)
        .collect();
    {
        let mut memory = memory();
        memory.pairings.retain(|_, (_, born)| born.elapsed() < PAIRING_LIFE);
        memory.pairings.insert(raw.clone(), (access, Instant::now()));
    }
    Ok(Pairing {
        url: format!("{}/mcp", address.replacen("wss://", "https://", 1).trim_end_matches('/')),
        code: format!("{}-{}", &raw[..4], &raw[4..]),
        expires_in_secs: PAIRING_LIFE.as_secs(),
        access,
    })
}

/// A code as stored: dashes, spaces and case dropped.
fn normalize(code: &str) -> String {
    code.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_uppercase()
}

/// Takes a typed code, once. Wrong ones count against every outstanding code.
fn redeem(typed: &str) -> Option<Access> {
    let typed = normalize(typed);
    let mut memory = memory();
    memory.pairings.retain(|_, (_, born)| born.elapsed() < PAIRING_LIFE);
    if let Some((access, _)) = memory.pairings.remove(&typed) {
        return Some(access);
    }
    memory.failures += 1;
    if memory.failures >= MAX_FAILURES {
        memory.pairings.clear();
        memory.failures = 0;
    }
    None
}

pub async fn assistants() -> Result<Vec<AssistantSummary>, String> {
    let book = read_book().await.map_err(|e| format!("{e:#}"))?;
    let now = chrono::Utc::now();
    Ok(book
        .grants
        .into_iter()
        .filter(|g| live(&g.expires, now))
        .map(|g| AssistantSummary {
            id: g.id,
            name: g.name,
            access: g.access,
            created: g.created,
            last_used: g.last_used,
            user: g.user.map(|u| u.email),
        })
        .collect())
}

/// Signs an assistant out: its refresh token stops working at once, and so do
/// the access tokens it holds.
pub async fn revoke(sink: Sink, id: String) -> Result<Vec<AssistantSummary>, String> {
    {
        let _held = BOOK.lock().await;
        let mut book = read_book().await.map_err(|e| format!("{e:#}"))?;
        let before = book.grants.len();
        book.grants.retain(|g| g.id != id);
        if book.grants.len() == before {
            return Err(format!("no assistant {id}"));
        }
        write_book(&book).await.map_err(|e| format!("{e:#}"))?;
        memory().access.retain(|_, live| live.grant != id);
    }
    let _ = sink.emit(CHANGED, ());
    assistants().await
}

fn live(expires: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    chrono::DateTime::parse_from_rfc3339(expires).is_ok_and(|e| e > now)
}

/// What a bearer token on `/mcp` is good for, if anything, and the Dray
/// account behind it, which the caller asks [`account::admit`] about.
pub fn check(token: &str) -> Option<(Access, Option<String>)> {
    let mut memory = memory();
    memory.access.retain(|_, live| live.born.elapsed() < ACCESS_LIFE);
    memory.access.get(&hash(token)).map(|live| (live.access, live.user.clone()))
}

pub fn resource_metadata(base: &str) -> Value {
    json!({
        "resource": format!("{base}/mcp"),
        "authorization_servers": [base],
        "bearer_methods_supported": ["header"],
        "resource_name": "Dray",
    })
}

pub fn server_metadata(base: &str) -> Value {
    json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/oauth/authorize"),
        "token_endpoint": format!("{base}/oauth/token"),
        "registration_endpoint": format!("{base}/oauth/register"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
    })
}

/// `https:`, a loopback `http:`, or an app's own scheme — Grok Bot registers
/// `cursor://…`, and strict servers refusing it refuse the whole registration.
fn acceptable_redirect(uri: &str) -> bool {
    let Some((scheme, rest)) = uri.split_once(':') else { return false };
    match scheme.to_ascii_lowercase().as_str() {
        "https" => rest.starts_with("//"),
        "http" => loopback(uri).is_some(),
        "javascript" | "data" | "file" | "vbscript" | "blob" => false,
        s => s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && s.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)),
    }
}

/// A loopback `http:` URI with its port taken out, for RFC 8252's
/// port-agnostic match: a native client listens on whatever port is free.
fn loopback(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("http://")?;
    let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let host = if authority.starts_with('[') {
        authority.split_inclusive(']').next()?
    } else {
        authority.split(':').next()?
    };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]").then(|| format!("http://{host}{path}"))
}

fn redirect_matches(registered: &[String], asked: &str) -> bool {
    registered.iter().any(|r| r == asked || loopback(r).is_some_and(|r| Some(r) == loopback(asked)))
}

/// `POST /oauth/register`, RFC 7591. Answers `(status, body)`.
pub async fn register(body: &[u8]) -> (u16, Value) {
    #[derive(Deserialize)]
    struct Ask {
        #[serde(default)]
        redirect_uris: Vec<String>,
        #[serde(default)]
        client_name: Option<String>,
    }
    let Ok(ask) = serde_json::from_slice::<Ask>(body) else {
        return (400, json!({ "error": "invalid_client_metadata", "error_description": "not a registration" }));
    };
    if ask.redirect_uris.is_empty()
        || ask.redirect_uris.len() > MAX_REDIRECTS
        || !ask.redirect_uris.iter().all(|u| u.len() <= MAX_REDIRECT_LEN && acceptable_redirect(u))
    {
        return (400, json!({ "error": "invalid_redirect_uri" }));
    }
    {
        let mut memory = memory();
        let window = Instant::now().checked_sub(Duration::from_secs(60));
        memory.registrations.retain(|at| window.is_none_or(|w| *at > w));
        if memory.registrations.len() >= REGISTRATIONS_PER_MINUTE {
            return (429, json!({ "error": "temporarily_unavailable", "error_description": "too many registrations; try again in a minute" }));
        }
        memory.registrations.push_back(Instant::now());
    }
    let client = Client {
        id: secret("dray-client-"),
        name: ask.client_name.map(|n| n.chars().take(80).collect()),
        redirect_uris: ask.redirect_uris,
        created: now(),
    };
    let saved = async {
        let _held = BOOK.lock().await;
        let mut book = read_book().await?;
        let cutoff = chrono::Utc::now() - chrono::Duration::hours(IDLE_CLIENT_HOURS);
        let granted: std::collections::HashSet<String> = book.grants.iter().map(|g| g.client_id.clone()).collect();
        book.clients.retain(|c| {
            granted.contains(&c.id) || chrono::DateTime::parse_from_rfc3339(&c.created).is_ok_and(|t| t > cutoff)
        });
        // Oldest first, as they were pushed: drop pending ones from the front.
        let mut pending = book.clients.iter().filter(|c| !granted.contains(&c.id)).count();
        book.clients.retain(|c| {
            let drop = pending >= MAX_PENDING && !granted.contains(&c.id);
            pending -= usize::from(drop);
            !drop
        });
        book.clients.push(client.clone());
        write_book(&book).await
    };
    if let Err(e) = saved.await {
        return (500, json!({ "error": "server_error", "error_description": format!("{e:#}") }));
    }
    (
        201,
        json!({
            "client_id": client.id,
            "client_id_issued_at": chrono::Utc::now().timestamp(),
            "client_name": client.name,
            "redirect_uris": client.redirect_uris,
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        }),
    )
}

/// What an authorization request carries, as the page and its form post it.
#[derive(Debug, Default, Clone)]
pub struct AuthorizeAsk {
    client_id: String,
    redirect_uri: String,
    state: Option<String>,
    challenge: String,
    method: String,
    response_type: String,
}

impl AuthorizeAsk {
    pub fn from_pairs<'a>(pairs: impl Iterator<Item = (std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>) -> (Self, Option<Typed>) {
        let mut ask = Self::default();
        let mut code = None;
        let mut via = false;
        for (key, value) in pairs {
            let value = value.into_owned();
            match &*key {
                "client_id" => ask.client_id = value,
                "redirect_uri" => ask.redirect_uri = value,
                "state" => ask.state = Some(value),
                "code_challenge" => ask.challenge = value,
                "code_challenge_method" => ask.method = value,
                "response_type" => ask.response_type = value,
                "pairing_code" => code = Some(value),
                "via" => via = value == "dray",
                _ => {}
            }
        }
        (ask, code.map(Typed::Code).or(via.then_some(Typed::Dray)))
    }
}

/// What the sign-in page's form posted: a pairing code, or Continue.
pub enum Typed {
    Code(String),
    Dray,
}

/// What the page says to the reader, or why it cannot be shown. An unknown
/// client or redirect is answered on the page and never redirected to, or this
/// would be an open redirect.
pub enum Page {
    /// `site` is where Continue goes, `drayhq.com` outside testing. `pairing`
    /// opens the pairing-code form, for an answer to a code typed there.
    Ask { client: String, redirect_host: String, site: String, error: Option<String>, pairing: bool },
    /// Nothing signs in to a server not linked to an org.
    Unlinked,
    Refused(String),
    Redirect(String),
}

async fn vet(ask: &AuthorizeAsk) -> Result<Client, String> {
    let book = read_book().await.map_err(|e| format!("{e:#}"))?;
    let client = book
        .clients
        .into_iter()
        .find(|c| c.id == ask.client_id)
        .ok_or("This assistant is not registered here. Remove the connector and add it again.")?;
    if !redirect_matches(&client.redirect_uris, &ask.redirect_uri) {
        return Err("The address this sign-in returns to was not registered.".into());
    }
    if ask.response_type != "code" || ask.challenge.is_empty() || ask.method != "S256" {
        return Err("This sign-in request is not one Dray answers: it needs PKCE (S256).".into());
    }
    Ok(client)
}

fn redirect_host(uri: &str) -> String {
    let after = uri.split_once("://").map(|(_, r)| r).unwrap_or(uri);
    after.split(['/', '?', '#']).next().unwrap_or(after).to_string()
}

fn client_label(client: &Client) -> String {
    client.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "An assistant".into())
}

fn ask_page(client: &Client, ask: &AuthorizeAsk, site: &str, error: Option<String>, pairing: bool) -> Page {
    Page::Ask {
        client: client_label(client),
        redirect_host: redirect_host(&ask.redirect_uri),
        site: account::site_host(site),
        error,
        pairing,
    }
}

/// `GET /oauth/authorize`.
pub async fn authorize_page(ask: &AuthorizeAsk, sink: &Sink) -> Page {
    let client = match vet(ask).await {
        Ok(client) => client,
        Err(why) => return Page::Refused(why),
    };
    match org_link::credential(sink).await {
        Some(cred) => ask_page(&client, ask, &cred.site, None, false),
        None => Page::Unlinked,
    }
}

/// `POST /oauth/authorize`: Continue, which hands the reader to drayhq.com,
/// or a pairing code, which a right one turns into an authorization code at
/// once. `base` is where the site may send the reader back to, none where
/// the page was reached at an address that isn't this server's own.
pub async fn authorize(ask: &AuthorizeAsk, typed: Typed, base: Option<&str>, sink: &Sink) -> Page {
    let client = match vet(ask).await {
        Ok(client) => client,
        Err(why) => return Page::Refused(why),
    };
    let Some(cred) = org_link::credential(sink).await else { return Page::Unlinked };
    match typed {
        Typed::Dray => {
            let Some(base) = base else {
                let why = "Open this sign-in at the server's Remote access address.".to_string();
                return ask_page(&client, ask, &cred.site, Some(why), false);
            };
            let label = client_label(&client);
            match account::begin(&cred, ask.clone(), base, &label, &redirect_host(&ask.redirect_uri)).await {
                Ok(url) => Page::Redirect(url),
                Err(why) => ask_page(&client, ask, &cred.site, Some(why), false),
            }
        }
        Typed::Code(typed) => match redeem(&typed) {
            Some(access) => send_code(client.id, ask, access, None),
            None => {
                let why = "That code is wrong or has expired. Make a new one in Dray.".to_string();
                ask_page(&client, ask, &cred.site, Some(why), true)
            }
        },
    }
}

/// `GET /oauth/dray`: back from drayhq.com. An assertion that checks out
/// becomes an authorization code; a cancel goes back to the assistant as one.
pub async fn dray_return(query: &str, sink: &Sink) -> Page {
    let Some(cred) = org_link::credential(sink).await else { return Page::Unlinked };
    let query: HashMap<String, String> = form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    let (ask, outcome) = match account::finish(&cred, &query).await {
        Ok(account::Finished::Allowed { ask, access, user }) => (ask, Some((access, user))),
        Ok(account::Finished::Cancelled(ask)) => (ask, None),
        Err(why) => return Page::Refused(why.into()),
    };
    // Vetted again: the client may have been dropped while the reader was away.
    let client = match vet(&ask).await {
        Ok(client) => client,
        Err(why) => return Page::Refused(why),
    };
    match outcome {
        Some((access, user)) => send_code(client.id, &ask, access, Some(user)),
        None => send_back(&ask, &[("error", "access_denied")]),
    }
}

/// Mints an authorization code and sends the browser back to the assistant.
fn send_code(client_id: String, ask: &AuthorizeAsk, access: Access, user: Option<DrayUser>) -> Page {
    let code = secret("");
    {
        let mut memory = memory();
        memory.codes.retain(|_, c| c.born.elapsed() < CODE_LIFE);
        memory.codes.insert(
            hash(&code),
            Code {
                client_id,
                redirect_uri: ask.redirect_uri.clone(),
                challenge: ask.challenge.clone(),
                access,
                user,
                born: Instant::now(),
            },
        );
    }
    send_back(ask, &[("code", &code)])
}

/// The assistant's redirect with `params` and its own `state` added.
fn send_back(ask: &AuthorizeAsk, params: &[(&str, &str)]) -> Page {
    let mut target = ask.redirect_uri.clone();
    target.push(if target.contains('?') { '&' } else { '?' });
    let mut query = form_urlencoded::Serializer::new(String::new());
    query.extend_pairs(params);
    if let Some(state) = &ask.state {
        query.append_pair("state", state);
    }
    target.push_str(&query.finish());
    Page::Redirect(target)
}

fn token_error(error: &str, description: &str) -> (u16, Value) {
    (400, json!({ "error": error, "error_description": description }))
}

/// Mints an access token and a fresh refresh token for `grant`, which the
/// caller then saves.
fn issue(grant: &mut Grant) -> Value {
    let access = secret("dray_at_");
    let refresh = secret("dray_rt_");
    grant.refresh = hash(&refresh);
    grant.last_used = now();
    grant.expires = (chrono::Utc::now() + chrono::Duration::days(REFRESH_DAYS)).to_rfc3339();
    let user = grant.user.as_ref().map(|u| u.id.clone());
    memory().access.insert(hash(&access), Live { grant: grant.id.clone(), access: grant.access, user, born: Instant::now() });
    json!({
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": ACCESS_LIFE.as_secs(),
        "refresh_token": refresh,
    })
}

/// `POST /oauth/token`: a code exchanged, or a refresh token rotated.
pub async fn token(body: &[u8], sink: &Sink) -> (u16, Value) {
    let form: HashMap<String, String> = form_urlencoded::parse(body).into_owned().collect();
    let field = |k: &str| -> String { form.get(k).cloned().unwrap_or_default() };
    match field("grant_type").as_str() {
        "authorization_code" => {
            let Some(code) = memory().codes.remove(&hash(&field("code"))) else {
                return token_error("invalid_grant", "unknown or used code");
            };
            if code.born.elapsed() > CODE_LIFE
                || code.client_id != field("client_id")
                || code.redirect_uri != field("redirect_uri")
            {
                return token_error("invalid_grant", "code does not match this request");
            }
            let proof = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(sha2::Sha256::digest(field("code_verifier").as_bytes()));
            if proof != code.challenge {
                return token_error("invalid_grant", "PKCE verifier does not match");
            }
            let issued = async {
                let _held = BOOK.lock().await;
                let mut book = read_book().await?;
                let name = book
                    .clients
                    .iter()
                    .find(|c| c.id == code.client_id)
                    .map(client_label)
                    .unwrap_or_else(|| "An assistant".into());
                let mut grant = Grant {
                    id: uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
                    client_id: code.client_id.clone(),
                    name,
                    access: code.access,
                    created: now(),
                    last_used: now(),
                    refresh: String::new(),
                    expires: String::new(),
                    user: code.user.clone(),
                };
                let answer = issue(&mut grant);
                book.grants.push(grant);
                write_book(&book).await?;
                anyhow::Ok(answer)
            };
            match issued.await {
                Ok(answer) => {
                    let _ = sink.emit(CHANGED, ());
                    crate::analytics::feature_used("mcp_assistant");
                    (200, answer)
                }
                Err(e) => (500, json!({ "error": "server_error", "error_description": format!("{e:#}") })),
            }
        }
        "refresh_token" => {
            let wanted = hash(&field("refresh_token"));
            // Asked before the lock, since it may wait on the site.
            let user = match read_book().await {
                Ok(book) => book.grants.into_iter().find(|g| g.refresh == wanted).and_then(|g| g.user).map(|u| u.id),
                Err(e) => return (500, json!({ "error": "server_error", "error_description": format!("{e:#}") })),
            };
            match account::admit(sink, user.as_deref()).await {
                Admit::Yes => {}
                Admit::Unlinked => return token_error("invalid_grant", "this server is not linked to a Dray account"),
                Admit::Unreachable => {
                    let why = "can't reach drayhq.com to check this account's access";
                    return (503, json!({ "error": "temporarily_unavailable", "error_description": why }));
                }
                Admit::Refused => {
                    // Gone for good: the assistant must sign in again, so the
                    // list shouldn't show it.
                    let dropped = async {
                        let _held = BOOK.lock().await;
                        let mut book = read_book().await?;
                        book.grants.retain(|g| g.refresh != wanted);
                        write_book(&book).await
                    };
                    if dropped.await.is_ok() {
                        let _ = sink.emit(CHANGED, ());
                    }
                    return token_error("invalid_grant", "this account no longer has access to this server");
                }
            }
            let refreshed = async {
                let _held = BOOK.lock().await;
                let mut book = read_book().await?;
                let now = chrono::Utc::now();
                let Some(grant) = book.grants.iter_mut().find(|g| {
                    g.refresh == wanted && live(&g.expires, now) && (field("client_id").is_empty() || g.client_id == field("client_id"))
                }) else {
                    return anyhow::Ok(None);
                };
                let answer = issue(grant);
                write_book(&book).await?;
                Ok(Some(answer))
            };
            match refreshed.await {
                Ok(Some(answer)) => (200, answer),
                Ok(None) => token_error("invalid_grant", "unknown, expired or revoked refresh token"),
                Err(e) => (500, json!({ "error": "server_error", "error_description": format!("{e:#}") })),
            }
        }
        _ => token_error("unsupported_grant_type", "authorization_code or refresh_token"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirects_an_assistant_may_register() {
        assert!(acceptable_redirect("https://claude.ai/api/mcp/auth_callback"));
        assert!(acceptable_redirect("http://localhost:3118/callback"));
        assert!(acceptable_redirect("http://127.0.0.1/callback"));
        assert!(acceptable_redirect("cursor://anysphere.cursor-mcp/oauth/callback"));
        assert!(!acceptable_redirect("http://evil.test/callback"), "plain http off loopback");
        assert!(!acceptable_redirect("javascript:alert(1)"));
        assert!(!acceptable_redirect("not a uri"));
    }

    #[test]
    fn loopback_matches_on_any_port() {
        let registered = vec!["http://localhost/callback".to_string()];
        assert!(redirect_matches(&registered, "http://localhost:51234/callback"));
        assert!(!redirect_matches(&registered, "http://localhost:51234/other"));
        assert!(!redirect_matches(&["https://a.test/cb".to_string()], "https://a.test/cb2"));
    }

    #[test]
    fn a_code_works_once_and_reads_loosely() {
        memory().pairings.insert("ABCDEFGH".into(), (Access::Read, Instant::now()));
        assert_eq!(redeem("abcd-efgh"), Some(Access::Read));
        assert_eq!(redeem("ABCD-EFGH"), None, "a code is spent on use");
    }

    #[tokio::test]
    async fn registration_is_bounded_before_anything_is_written() {
        let many: Vec<String> = (0..=MAX_REDIRECTS).map(|i| format!("https://a.test/{i}")).collect();
        let (status, _) = register(&serde_json::to_vec(&json!({ "redirect_uris": many })).unwrap()).await;
        assert_eq!(status, 400, "too many redirects");
        let long = format!("https://a.test/{}", "x".repeat(MAX_REDIRECT_LEN));
        let (status, _) = register(&serde_json::to_vec(&json!({ "redirect_uris": [long] })).unwrap()).await;
        assert_eq!(status, 400, "a redirect too long");

        memory().registrations.extend(std::iter::repeat_n(Instant::now(), REGISTRATIONS_PER_MINUTE));
        let (status, _) = register(br#"{"redirect_uris":["https://a.test/cb"]}"#).await;
        assert_eq!(status, 429);
        memory().registrations.clear();
    }

    #[test]
    fn a_replaced_code_dies_at_once() {
        memory().pairings.insert("JKMNPQRS".into(), (Access::Full, Instant::now()));
        memory().pairings.remove(&normalize("jkmn-pqrs"));
        assert_eq!(redeem("JKMN-PQRS"), None);
    }
}
