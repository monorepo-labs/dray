//! MCP sign-in through drayhq.com (#874). The server keeps its own OAuth and
//! hands only the "who are you" step to the site:
//!
//! 1. The sign-in page's Continue pushes the flow to the site with this
//!    server's link credential ([`begin`]), so the site knows the address it
//!    returns to is this server's and never takes one from the browser.
//! 2. The reader signs in there; the site checks the allow list and org
//!    membership and sends the browser back to `/oauth/dray` with an Ed25519
//!    JWT, audience this server's id, nonce this flow's.
//! 3. [`finish`] checks it against the site's JWKS and the flow ends in an
//!    ordinary authorization code.
//!
//! Every later MCP call asks the site again ([`admit`]), so taking someone
//! off the allow list cuts their assistants off at once.

use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::auth::{Access, AuthorizeAsk};
use crate::{
    org_link::{self, Credential},
    sink::Sink,
};

/// As long as the site keeps its half of the flow waiting.
const FLOW_LIFE: Duration = Duration::from_secs(10 * 60);
/// Flows begun and never finished. Each costs a call to the site under this
/// server's credential, so the bound is on the site's side too.
const MAX_FLOWS: usize = 100;
const TIMEOUT: Duration = Duration::from_secs(10);
/// How long an answer about someone's access is trusted. Short, so removal is
/// felt at once, but long enough that a burst of tool calls asks once.
const ACCESS_FRESH: Duration = Duration::from_secs(10);
/// How long a yes outlives the site being unreachable, so an outage at
/// drayhq.com doesn't take every assistant down with it.
const ACCESS_GRACE: Duration = Duration::from_secs(10 * 60);
/// An unknown key id refetches the key set, at most this often.
const JWKS_REFETCH: Duration = Duration::from_secs(30);
/// Clock skew forgiven on the assertion's expiry.
const LEEWAY_SECS: i64 = 60;

/// The Dray account an assistant was signed in with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrayUser {
    pub id: String,
    pub email: String,
    pub name: String,
}

struct Flow {
    ask: AuthorizeAsk,
    born: Instant,
}

struct Seen {
    allowed: bool,
    checked: Instant,
    last_yes: Option<Instant>,
}

struct Keys {
    keys: HashMap<String, Vec<u8>>,
    fetched: Instant,
}

#[derive(Default)]
struct Memory {
    flows: HashMap<String, Flow>,
    access: HashMap<String, Seen>,
    keys: HashMap<String, Keys>,
}

static MEMORY: LazyLock<Mutex<Memory>> = LazyLock::new(Default::default);

fn memory() -> std::sync::MutexGuard<'static, Memory> {
    MEMORY.lock().unwrap_or_else(|e| e.into_inner())
}

/// `drayhq.com` for `https://www.drayhq.com`, as the page's button names it.
pub fn site_host(site: &str) -> String {
    let host = site.split_once("://").map_or(site, |(_, rest)| rest);
    host.strip_prefix("www.").unwrap_or(host).trim_end_matches('/').to_string()
}

const UNLINKED: &str = "This server is no longer linked to a Dray account. Link it again, then connect.";

/// Pushes a sign-in to the site and answers where to send the browser.
pub async fn begin(cred: &Credential, ask: AuthorizeAsk, base: &str, client: &str, redirect_host: &str) -> Result<String, String> {
    let state = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let site = site_host(&cred.site);
    let answer = crate::http()
        .post(format!("{}/api/mcp/sign-in", cred.site))
        .bearer_auth(&cred.token)
        .json(&json!({
            "returnUrl": format!("{base}/oauth/dray"),
            "state": state,
            "client": client,
            "redirectHost": redirect_host,
        }))
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|_| format!("Couldn't reach {site}. Try again in a minute."))?;
    if answer.status() == reqwest::StatusCode::UNAUTHORIZED {
        org_link::recheck_soon();
        return Err(UNLINKED.into());
    }
    let ok = answer.status().is_success();
    let body: Value = answer.json().await.unwrap_or_default();
    let url = body["url"].as_str().filter(|_| ok).ok_or_else(|| format!("{site} refused this sign-in. Try again in a minute."))?;
    let mut memory = memory();
    memory.flows.retain(|_, f| f.born.elapsed() < FLOW_LIFE);
    if memory.flows.len() >= MAX_FLOWS {
        let oldest = memory.flows.iter().min_by_key(|(_, f)| f.born).map(|(k, _)| k.clone());
        memory.flows.remove(&oldest.unwrap_or_default());
    }
    memory.flows.insert(state, Flow { ask, born: Instant::now() });
    Ok(url.to_string())
}

/// How a trip to the site ended.
pub enum Finished {
    Allowed { ask: AuthorizeAsk, access: Access, user: DrayUser },
    Cancelled(AuthorizeAsk),
}

fn take_flow(state: &str) -> Option<AuthorizeAsk> {
    let mut memory = memory();
    memory.flows.remove(state).filter(|f| f.born.elapsed() < FLOW_LIFE).map(|f| f.ask)
}

/// `GET /oauth/dray`: the site sends the browser back with an assertion, or
/// with `error=access_denied` when the reader cancelled.
pub async fn finish(cred: &Credential, query: &HashMap<String, String>) -> Result<Finished, String> {
    if query.get("error").is_some_and(|e| e == "access_denied") {
        let ask = query.get("state").and_then(|s| take_flow(s)).ok_or(EXPIRED)?;
        return Ok(Finished::Cancelled(ask));
    }
    let token = query.get("assertion").ok_or(EXPIRED)?;
    let kid = header_kid(token).ok_or(UNREADABLE)?;
    let key = key(&cred.site, &kid).await.ok_or(UNREADABLE)?;
    let claims = verify(token, &key, &cred.server_id, chrono::Utc::now().timestamp()).map_err(|_| UNREADABLE)?;
    let ask = take_flow(&claims.nonce).ok_or(EXPIRED)?;
    let access = if claims.access == "read" { Access::Read } else { Access::Full };
    let user = DrayUser { id: claims.sub, email: claims.email, name: claims.name };
    // A sign-in that just said yes needn't be asked about again for a while.
    memory().access.insert(
        user.id.clone(),
        Seen { allowed: true, checked: Instant::now(), last_yes: Some(Instant::now()) },
    );
    Ok(Finished::Allowed { ask, access, user })
}

const EXPIRED: &str = "This sign-in has expired. Start again from your assistant.";
const UNREADABLE: &str = "drayhq.com's answer couldn't be checked. Start again from your assistant.";

#[derive(Debug, Deserialize)]
struct Claims {
    sub: String,
    aud: Value,
    exp: i64,
    nonce: String,
    access: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    name: String,
}

fn b64(part: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(part).ok()
}

fn header_kid(token: &str) -> Option<String> {
    let header: Value = serde_json::from_slice(&b64(token.split('.').next()?)?).ok()?;
    header["kid"].as_str().map(str::to_string)
}

/// Checks an assertion's signature, audience and expiry. The issuer is not
/// read: the key came from the site this server is linked to, so the
/// signature already says who issued it.
fn verify(token: &str, key: &[u8], server_id: &str, now: i64) -> Result<Claims, &'static str> {
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(signature), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err("not a JWT");
    };
    let head: Value = serde_json::from_slice(&b64(header).ok_or("header")?).map_err(|_| "header")?;
    // Pinned, so a token naming another algorithm is never tried against this key.
    if head["alg"] != "EdDSA" {
        return Err("algorithm");
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(format!("{header}.{payload}").as_bytes(), &b64(signature).ok_or("signature")?)
        .map_err(|_| "signature")?;
    let claims: Claims = serde_json::from_slice(&b64(payload).ok_or("payload")?).map_err(|_| "payload")?;
    let audience_ok = match &claims.aud {
        Value::String(aud) => aud == server_id,
        Value::Array(auds) => auds.iter().any(|a| a == server_id),
        _ => false,
    };
    if !audience_ok {
        return Err("audience");
    }
    if claims.exp + LEEWAY_SECS < now {
        return Err("expired");
    }
    if claims.sub.is_empty() || claims.nonce.is_empty() {
        return Err("claims");
    }
    Ok(claims)
}

/// The site's public key `kid`, refetching the key set when it is unknown,
/// as it is after the site rotates.
async fn key(site: &str, kid: &str) -> Option<Vec<u8>> {
    {
        let memory = memory();
        if let Some(keys) = memory.keys.get(site) {
            if let Some(key) = keys.keys.get(kid) {
                return Some(key.clone());
            }
            if keys.fetched.elapsed() < JWKS_REFETCH {
                return None;
            }
        }
    }
    let set: Value = crate::http()
        .get(format!("{site}/api/auth/jwks"))
        .timeout(TIMEOUT)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let keys: HashMap<String, Vec<u8>> = set["keys"]
        .as_array()?
        .iter()
        .filter(|k| k["kty"] == "OKP" && k["crv"] == "Ed25519")
        .filter_map(|k| Some((k["kid"].as_str()?.to_string(), b64(k["x"].as_str()?)?)))
        .collect();
    let found = keys.get(kid).cloned();
    memory().keys.insert(site.to_string(), Keys { keys, fetched: Instant::now() });
    found
}

/// Whether an MCP call or a refresh may go ahead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admit {
    Yes,
    /// This server isn't linked, so no assistant may use it.
    Unlinked,
    /// The account that signed the assistant in has lost access.
    Refused,
    /// The site couldn't be asked and the last yes is too old to lean on.
    Unreachable,
}

/// Every MCP call's check: the server must be linked, and an assistant signed
/// in through the site must still be allowed there. A pairing code's grant
/// names no account, so being linked is all it needs.
pub async fn admit(sink: &Sink, user: Option<&str>) -> Admit {
    let Some(cred) = org_link::credential(sink).await else { return Admit::Unlinked };
    let Some(user) = user else { return Admit::Yes };
    {
        let memory = memory();
        if let Some(seen) = memory.access.get(user).filter(|s| s.checked.elapsed() < ACCESS_FRESH) {
            return if seen.allowed { Admit::Yes } else { Admit::Refused };
        }
    }
    let answer = crate::http()
        .post(format!("{}/api/mcp/access", cred.site))
        .bearer_auth(&cred.token)
        .json(&json!({ "userId": user }))
        .timeout(TIMEOUT)
        .send()
        .await;
    let told = match answer {
        Ok(a) if a.status() == reqwest::StatusCode::UNAUTHORIZED => {
            org_link::recheck_soon();
            return Admit::Unlinked;
        }
        Ok(a) if a.status().is_success() => a.json::<Value>().await.ok().and_then(|b| b["allowed"].as_bool()),
        _ => None,
    };
    let mut memory = memory();
    let last_yes = memory.access.get(user).and_then(|s| s.last_yes);
    match told {
        Some(allowed) => {
            let last_yes = if allowed { Some(Instant::now()) } else { None };
            memory.access.insert(user.to_string(), Seen { allowed, checked: Instant::now(), last_yes });
            if allowed { Admit::Yes } else { Admit::Refused }
        }
        None if last_yes.is_some_and(|at| at.elapsed() < ACCESS_GRACE) => Admit::Yes,
        None => Admit::Unreachable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair as _;

    fn signed(claims: Value) -> (String, Vec<u8>) {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let enc = |v: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
        let input = format!("{}.{}", enc(&json!({ "alg": "EdDSA", "kid": "k1" })), enc(&claims));
        let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(pair.sign(input.as_bytes()));
        (format!("{input}.{signature}"), pair.public_key().as_ref().to_vec())
    }

    fn claims(aud: &str, exp: i64) -> Value {
        json!({ "sub": "u1", "aud": aud, "exp": exp, "nonce": "n1", "access": "read", "email": "a@b.c", "name": "A" })
    }

    #[test]
    fn a_good_assertion_is_read() {
        let (token, key) = signed(claims("server-1", 1_000));
        assert_eq!(header_kid(&token).as_deref(), Some("k1"));
        let read = verify(&token, &key, "server-1", 900).unwrap();
        assert_eq!((read.sub.as_str(), read.nonce.as_str(), read.access.as_str()), ("u1", "n1", "read"));
    }

    #[test]
    fn an_assertion_for_another_server_or_past_its_life_is_refused() {
        let (token, key) = signed(claims("server-1", 1_000));
        assert_eq!(verify(&token, &key, "server-2", 900).unwrap_err(), "audience");
        assert_eq!(verify(&token, &key, "server-1", 1_000 + LEEWAY_SECS + 1).unwrap_err(), "expired");
    }

    #[test]
    fn a_tampered_or_foreign_assertion_is_refused() {
        let (token, _) = signed(claims("server-1", 1_000));
        let (_, other_key) = signed(claims("server-1", 1_000));
        assert_eq!(verify(&token, &other_key, "server-1", 900).unwrap_err(), "signature");

        let (token, key) = signed(claims("server-1", 1_000));
        let mut parts: Vec<&str> = token.split('.').collect();
        let forged = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims("server-1", 9_999).to_string());
        parts[1] = &forged;
        assert_eq!(verify(&parts.join("."), &key, "server-1", 900).unwrap_err(), "signature");
    }

    #[test]
    fn the_button_names_the_bare_site() {
        assert_eq!(site_host("https://www.drayhq.com"), "drayhq.com");
        assert_eq!(site_host("http://localhost:3000/"), "localhost:3000");
    }
}
