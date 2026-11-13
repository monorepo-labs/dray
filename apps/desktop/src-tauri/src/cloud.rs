//! Dray Cloud's control plane (#857), as the app speaks to it: list the
//! machines, start one for a task, resume one, delete a settled task's. The connections are `servers.rs`'s, each
//! machine a `Saved` marked `cloud`; this file only talks HTTP.
//!
//! The contract is fixed in the issue and shared with `apps/web` and
//! `dray-serve`, so a field here changes there too.

use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

/// Where the client key sits in `credentials.json`.
pub const KEY: &str = "dray-cloud";

const DEFAULT_URL: &str = "https://www.drayhq.com/api/cloud";

/// Boat answers a fork or a create slower than a list, so one timeout for all
/// would cut either short.
const READ: Duration = Duration::from_secs(15);
pub const START: Duration = Duration::from_secs(90);

/// `DRAY_CLOUD_URL`, else drayhq.com's.
pub fn base() -> String {
    std::env::var("DRAY_CLOUD_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_URL.into())
        .trim_end_matches('/')
        .to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Starting,
    Running,
    Stopping,
    Stopped,
    Error,
    /// A state this build cannot spell costs that machine's phase, not the list.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Machine {
    pub id: String,
    pub state: State,
    /// `None` until boat assigns the sandbox its subdomain, which a fork's
    /// first answer and its first listings can come before.
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Listing {
    /// Every machine's serve token, derived from one secret.
    pub token: String,
    pub machines: Vec<Machine>,
}

#[derive(Deserialize)]
struct One {
    machine: Machine,
}

/// One authorized call, answered as JSON or a sentence the Settings row can show.
async fn call(key: &str, method: reqwest::Method, path: &str, wait: Duration) -> Result<Value, String> {
    let answer = crate::http()
        .request(method, format!("{}{path}", base()))
        .bearer_auth(key)
        .timeout(wait)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Dray Cloud: {e}"))?;
    let status = answer.status().as_u16();
    let body: Value = answer.json().await.unwrap_or(Value::Null);
    match status {
        200..=299 => Ok(body),
        _ => Err(refusal(status, &body)),
    }
}

/// What a refused call says. Every route answers 404 while the control plane has
/// no key set, so 404 and 401 both read as the key being wrong.
pub fn refusal(status: u16, body: &Value) -> String {
    match (status, body["error"].as_str()) {
        // A machine already deleted; a key it doesn't take is a bare 404.
        (404, Some("not_found")) => "Dray Cloud no longer has that machine.".into(),
        (401 | 403 | 404, _) => "Dray Cloud didn't accept this key.".into(),
        (500.., None) => format!("Dray Cloud isn't answering right now ({status})."),
        (_, Some(error)) => format!("Dray Cloud said: {error}"),
        _ => format!("Dray Cloud answered {status}."),
    }
}

pub async fn list(key: &str) -> Result<Listing, String> {
    let body = call(key, reqwest::Method::GET, "/machines", READ).await?;
    serde_json::from_value(body).map_err(|e| format!("Dray Cloud answered in a shape this build can't read: {e}"))
}

/// A new machine for one task, created from the saved snapshot.
pub async fn start(key: &str) -> Result<Machine, String> {
    one(call(key, reqwest::Method::POST, "/machines", START).await?)
}

/// Deletes a machine for good. One already gone answers the same.
pub async fn delete(key: &str, id: &str) -> Result<(), String> {
    call(key, reqwest::Method::DELETE, &format!("/machines/{id}"), READ).await.map(drop)
}

pub async fn resume(key: &str, id: &str) -> Result<Machine, String> {
    one(call(key, reqwest::Method::POST, &format!("/machines/{id}/resume"), START).await?)
}

/// The signed-in reader's Dray Cloud account (#1021): plan, usage, GitHub and
/// agents, as `GET /account` describes them. Passed through untyped, since
/// only the setup sheet reads it and its shape is the site's. Asked with the
/// app's own Dray credential, which #889 keeps in `<home>/account.json`; no
/// credential, or one the site no longer takes, reads as `{ "user": null }`.
/// The app's to answer: it and its server share one home, so one file.
#[tauri::command]
pub async fn cloud_account() -> Result<Value, String> {
    let signed_out = || serde_json::json!({ "user": null });
    let Some(token) = account_token().await else { return Ok(signed_out()) };
    let answer = crate::http()
        .get(format!("{}/account", base()))
        .bearer_auth(token)
        .timeout(READ)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Dray Cloud: {e}"))?;
    let status = answer.status().as_u16();
    let body: Value = answer.json().await.unwrap_or(Value::Null);
    match status {
        200..=299 => Ok(body),
        // A revoked credential; #889's own recheck forgets the file.
        401 => Ok(signed_out()),
        _ => Err(refusal(status, &body)),
    }
}

/// The token #889's `dray_account` writes on sign-in. Read off the file
/// rather than through that module, so this lands before it; switch once it has.
async fn account_token() -> Option<String> {
    let home = crate::store::get_home_app_dir().await.ok()?;
    let held: Value = serde_json::from_slice(&tokio::fs::read(home.join("account.json")).await.ok()?).ok()?;
    held["token"].as_str().filter(|t| !t.is_empty()).map(str::to_owned)
}

fn one(body: Value) -> Result<Machine, String> {
    serde_json::from_value::<One>(body)
        .map(|one| one.machine)
        .map_err(|e| format!("Dray Cloud answered in a shape this build can't read: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_contracts_listing() {
        let listing: Listing = serde_json::from_value(json!({
            "token": "ab".repeat(32),
            "machines": [
                { "id": "sb_1", "state": "running", "url": "wss://abc-7317.on.boat.dev" },
                { "id": "sb_2", "state": "hibernating", "url": "wss://def-7317.on.boat.dev" },
            ],
        }))
        .unwrap();
        assert_eq!(listing.machines[0].state, State::Running);
        assert_eq!(listing.machines[1].state, State::Unknown);
    }

    #[test]
    fn a_machine_with_no_address_yet_costs_nothing() {
        let listing: Listing = serde_json::from_value(json!({
            "token": "ab".repeat(32),
            "machines": [{ "id": "bx_23456789", "state": "starting", "url": null }],
        }))
        .unwrap();
        assert_eq!(listing.machines[0].url, None);
        let one = one(json!({ "machine": { "id": "bx_23456789", "state": "starting", "url": null } })).unwrap();
        assert_eq!(one.url, None);
    }

    #[test]
    fn refusals_read_as_sentences() {
        assert_eq!(refusal(404, &Value::Null), "Dray Cloud didn't accept this key.");
        assert_eq!(refusal(404, &json!({ "error": "not_found" })), "Dray Cloud no longer has that machine.");
        assert_eq!(refusal(500, &json!({ "error": "boat down" })), "Dray Cloud said: boat down");
        assert_eq!(refusal(502, &Value::Null), "Dray Cloud isn't answering right now (502).");
    }
}
