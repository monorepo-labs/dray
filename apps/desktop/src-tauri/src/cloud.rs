//! Dray Cloud's control plane (#857), as the app speaks to it: list the
//! machines, start one for a task, resume one, delete a settled task's. The connections are `servers.rs`'s, each
//! machine a `Saved` marked `cloud`; this file only talks HTTP.
//!
//! The contract is fixed in the issue and shared with `apps/web` and
//! `dray-serve`, so a field here changes there too.
//!
//! Calls carry the Dray account this machine is signed in to, or the shared
//! key that predates accounts while one is still saved.

use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

/// Where the client key sits in `credentials.json`.
pub const KEY: &str = "dray-cloud";

/// What a call to the control plane carries, and where it goes.
#[derive(Debug, Clone, PartialEq)]
pub struct Cred {
    pub token: String,
    pub base: String,
    /// Whose machines it lists: `<site>#<user id>` for a signed-in account,
    /// `None` for the shared key. What `Saved::cloud_owner` records.
    pub owner: Option<String>,
}

/// The fields of `<home>/account.json` this reads: the app credential the
/// local server collects at sign-in (#889), the site it is good on, and who.
#[derive(Deserialize)]
struct Account {
    token: String,
    site: String,
    user: AccountUser,
}

#[derive(Deserialize)]
struct AccountUser {
    id: String,
}

/// The saved key, where there is one, since a key holder's machines stay the
/// key's until the switch. Else the signed-in account.
pub async fn cred() -> Option<Cred> {
    if let Some(token) = crate::issues::credential(KEY).await {
        return Some(Cred { token, base: base(), owner: None });
    }
    account().await
}

/// The signed-in account's credential, read off the file on every call: the
/// server writes it, so a sign-in or out lands here with nothing sent between
/// them. Its calls go to the site it signed in to, unless `DRAY_CLOUD_URL`
/// says otherwise.
pub async fn account() -> Option<Cred> {
    let path = crate::store::get_home_app_dir().await.ok()?.join("account.json");
    let set = std::env::var("DRAY_CLOUD_URL").is_ok_and(|u| !u.trim().is_empty());
    account_cred(&tokio::fs::read(path).await.ok()?, set.then(base))
}

/// `account.json`'s credential, sent to `url` where one is set.
fn account_cred(file: &[u8], url: Option<String>) -> Option<Cred> {
    let held: Account = serde_json::from_slice(file).ok()?;
    let site = held.site.trim_end_matches('/');
    let base = url.unwrap_or_else(|| format!("{site}/api/cloud"));
    let owner = Some(format!("{site}#{}", held.user.id));
    (!held.token.is_empty()).then_some(Cred { token: held.token, base, owner })
}

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
    /// The serve token it holds. An account lists the key's machines beside
    /// its own at the switch, and the two hold different tokens.
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Listing {
    /// The caller's serve token, for a machine that names none of its own.
    pub token: String,
    pub machines: Vec<Machine>,
}

#[derive(Deserialize)]
struct One {
    machine: Machine,
}

/// One authorized call, answered as JSON or a sentence the Settings row can show.
async fn call(cred: &Cred, method: reqwest::Method, path: &str, wait: Duration) -> Result<Value, String> {
    match send(cred, method, path, wait).await? {
        (200..=299, body) => Ok(body),
        (status, body) => Err(refusal(status, &body, cred.owner.is_some())),
    }
}

/// The status and body of one call, refused or not.
async fn send(cred: &Cred, method: reqwest::Method, path: &str, wait: Duration) -> Result<(u16, Value), String> {
    let answer = crate::http()
        .request(method, format!("{}{path}", cred.base))
        .bearer_auth(&cred.token)
        .timeout(wait)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Dray Cloud: {e}"))?;
    let status = answer.status().as_u16();
    Ok((status, answer.json().await.unwrap_or(Value::Null)))
}

/// What a refused call says. Every route answers 404 while the control plane is
/// off, so 404 and 401 both read as the credential being refused.
pub fn refusal(status: u16, body: &Value, account: bool) -> String {
    match (status, body["error"].as_str()) {
        // A machine already deleted; a key it doesn't take is a bare 404.
        (404, Some("not_found")) => "Dray Cloud no longer has that machine.".into(),
        (401 | 403 | 404, _) if account => "Dray Cloud isn't open to your account.".into(),
        (401 | 403 | 404, _) => "Dray Cloud didn't accept this key.".into(),
        // Worded by the control plane, so a plan's own cap reads right.
        (429, Some("machine_limit")) => {
            body["message"].as_str().unwrap_or("Too many Dray Cloud machines are running at once.").into()
        }
        // Billing (#1014): `out_of_hours` or `no_plan`, its sentence carrying
        // the billing page's link.
        (402, _) => body["message"].as_str().unwrap_or("Dray Cloud needs a plan with hours left.").into(),
        (500.., None) => format!("Dray Cloud isn't answering right now ({status})."),
        (_, Some(error)) => format!("Dray Cloud said: {error}"),
        _ => format!("Dray Cloud answered {status}."),
    }
}

pub async fn list(cred: &Cred) -> Result<Listing, String> {
    let body = call(cred, reqwest::Method::GET, "/machines", READ).await?;
    serde_json::from_value(body).map_err(|e| format!("Dray Cloud answered in a shape this build can't read: {e}"))
}

/// A new machine for one task, created from the saved snapshot.
pub async fn start(cred: &Cred) -> Result<Machine, String> {
    one(call(cred, reqwest::Method::POST, "/machines", START).await?)
}

/// Deletes a machine for good. One already gone answers the same. A 503 is
/// the control plane keeping the machine until it has read its meter, which
/// boat forgets on delete (#1014), so it is asked again a few times.
pub async fn delete(cred: &Cred, id: &str) -> Result<(), String> {
    let path = format!("/machines/{id}");
    let mut last = (503, Value::Null);
    for wait in DELETE_RETRIES {
        tokio::time::sleep(wait).await;
        last = send(cred, reqwest::Method::DELETE, &path, READ).await?;
        if last.0 != 503 {
            break;
        }
    }
    match last {
        (200..=299, _) => Ok(()),
        (status, body) => Err(refusal(status, &body, cred.owner.is_some())),
    }
}

/// Before each delete try: at once, then backing off.
const DELETE_RETRIES: [Duration; 4] =
    [Duration::ZERO, Duration::from_secs(2), Duration::from_secs(5), Duration::from_secs(15)];

pub async fn resume(cred: &Cred, id: &str) -> Result<Machine, String> {
    one(call(cred, reqwest::Method::POST, &format!("/machines/{id}/resume"), START).await?)
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
        assert_eq!(refusal(404, &Value::Null, false), "Dray Cloud didn't accept this key.");
        assert_eq!(refusal(401, &Value::Null, true), "Dray Cloud isn't open to your account.");
        assert_eq!(refusal(404, &json!({ "error": "not_found" }), true), "Dray Cloud no longer has that machine.");
        assert_eq!(refusal(500, &json!({ "error": "boat down" }), false), "Dray Cloud said: boat down");
        assert_eq!(refusal(502, &Value::Null, false), "Dray Cloud isn't answering right now (502).");
        let limit = json!({ "error": "machine_limit", "message": "8 Dray Cloud machines are already running." });
        assert_eq!(refusal(429, &limit, true), "8 Dray Cloud machines are already running.");
        let hours = json!({ "error": "out_of_hours", "message": "This month's Dray Cloud hours are used up." });
        assert_eq!(refusal(402, &hours, true), "This month's Dray Cloud hours are used up.");
    }

    /// The file as #889's `dray_account::Held` writes it.
    #[test]
    fn the_account_goes_to_the_site_it_signed_in_to() {
        let file = br#"{"token":"dra_x","site":"http://localhost:3000/","user":{"id":"u","name":"A","username":null,"image":null}}"#;
        let cred = account_cred(file, None).unwrap();
        let owner = Some("http://localhost:3000#u".into());
        assert_eq!(cred, Cred { token: "dra_x".into(), base: "http://localhost:3000/api/cloud".into(), owner });
        assert_eq!(account_cred(file, Some("https://x/api/cloud".into())).unwrap().base, "https://x/api/cloud");
        assert_eq!(account_cred(br#"{"token":"","site":"https://www.drayhq.com","user":{"id":"u"}}"#, None), None);
        assert_eq!(account_cred(b"not json", None), None);
    }

    #[test]
    fn a_machine_can_name_its_own_token() {
        let listing: Listing = serde_json::from_value(json!({
            "token": "ab".repeat(32),
            "machines": [{ "id": "bx_23456789", "state": "running", "url": null, "token": "cd".repeat(32) }],
        }))
        .unwrap();
        assert_eq!(listing.machines[0].token.as_deref(), Some("cd".repeat(32).as_str()));
    }
}
