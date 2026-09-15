//! fx's own MCP servers, in ACP's shape.
//!
//! **`fx acp` reads no MCP config of its own** — the ACP client owns the list,
//! so `session/new` with `mcpServers: []` is literally "this session has no MCP
//! servers" and fx honours it. That is what left Dray's fx sessions with none
//! while the same machine's `fx` shell had all of them (DRA-220). So the list
//! is read here, off `~/.fx/mcp.json`, the file `fx mcp add` writes and
//! `fx mcp path` names. fx's docs state both halves: "ACP never inherits
//! servers from `~/.fx/mcp.json`" and "ACP is noninteractive, so an ACP host
//! must supply headers for a protected MCP server".
//!
//! **Dray forwards only what the user already wrote into their own fx config,
//! plus one credential that is Dray's own.** A literal `headers` entry, or a
//! `header_env`/`bearer_token_env` naming an environment variable. fx's OAuth
//! credential store is never read: a server authenticated by `fx mcp auth`
//! keeps its token in the keychain, and fx deliberately refuses to lend those
//! credentials to an ACP-supplied server — one handed over with no usable
//! header fails with "Authentication required; supply an Authorization header
//! in the ACP MCP server configuration", even for a name fx itself holds a live
//! authenticated connection for. Nor to an *approved project* server: the same
//! entry in a workspace `.mcp.json`, trusted, logs `McpAuthenticationRequired`
//! in an ACP session. Measured both ways. Extracting that token and
//! re-injecting it would cross the boundary fx drew, and a snapshot access
//! token would expire with no refresh path anyway.
//!
//! **Linear is the one server Dray can authenticate itself, with its own key.**
//! `mcp.linear.app` takes an API key as `Authorization: Bearer` beside OAuth
//! (Linear's docs say so outright), and the Issues panel already holds one the
//! reader gave *Dray* — `~/.dray/credentials.json`, the same key already sent
//! to that host on every panel read. So a configured server at exactly that
//! host with no headers of its own goes over with that key. Host compared
//! parsed and whole, scheme checked, the same bargain `is_upload` makes: the
//! URL comes out of a config file, and a prefix match would post the key to
//! `mcp.linear.app.evil.test`.
//!
//! **A headerless HTTP server is two cases the config cannot tell apart, so fx
//! is asked.** An endpoint that wants no auth at all takes `headers: []` and
//! works; an OAuth-backed one takes the same list and fails the whole
//! `session/new`. The config line is identical for both — the credential lives
//! in the keychain, not the file — and `fx mcp list` (no `--connect`, no
//! network) is fx's own local answer: `auth=none` against `auth=authenticated`
//! for the very same entry under a home with no credentials stored. Only
//! `none` earns an empty header list; anything else, or a probe that failed,
//! is skipped.
//!
//! **A server that cannot be authenticated is skipped, never passed.** Every
//! server on the ACP surface is *required*: one that fails to start fails the
//! whole `session/new` with `-32602`, and there is no per-server optional flag
//! to soften it. So passing a server we cannot authenticate does not degrade to
//! "that one tool is missing", it degrades to the session not existing.
//!
//! Project-scoped `.mcp.json` is deliberately not read. A repo-supplied server
//! names a command to execute, so honouring one would make cloning a hostile
//! repo enough to run it, and Dray has no trust prompt to put in front of that.

use crate::issues::{read_key, IssueTracker};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;

/// Linear's MCP endpoint, the one host Dray's own key may be sent to.
const LINEAR_MCP_HOST: &str = "mcp.linear.app";

/// `~/.fx/mcp.json`, the path `fx mcp path` prints.
fn config_path() -> Option<PathBuf> {
    Some(std::env::home_dir()?.join(".fx/mcp.json"))
}

/// Whether `url` is Linear's MCP endpoint — host whole and scheme checked,
/// never a prefix, since the URL is config text and names where a key goes.
fn is_linear_mcp(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .map(|u| u.scheme() == "https" && u.host_str() == Some(LINEAR_MCP_HOST))
        .unwrap_or(false)
}

/// Everything Dray can authenticate a server with that is not in the config
/// line itself.
#[derive(Default)]
struct Secrets {
    /// Resolved values of every environment variable the config names.
    env: BTreeMap<String, String>,
    /// Server name → fx's own `auth=` reading, off `fx mcp list`.
    auth: BTreeMap<String, String>,
    /// The Issues panel's Linear key, for `mcp.linear.app` alone.
    linear_key: Option<String>,
}

/// What fx writes under `mcp`. Entries stay `Value` so each is parsed on its
/// own: this file is fx's, free to change a field's shape, and one entry it
/// changes under must cost that server rather than every other.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ConfigFile {
    mcp: BTreeMap<String, Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ServerConfig {
    /// `http`, `sse`, or absent/`stdio`.
    r#type: Option<String>,
    enabled: Option<bool>,
    command: Option<String>,
    args: Vec<String>,
    /// fx writes this as a map; ACP wants name/value entries.
    env: BTreeMap<String, String>,
    url: Option<String>,
    headers: BTreeMap<String, String>,
    /// Header name → environment variable holding its value.
    header_env: BTreeMap<String, String>,
    /// Environment variable holding a bearer token, fx's own spelling.
    bearer_token_env: Option<String>,
}

/// Every server fx is configured with that Dray can hand over, in ACP's shape.
///
/// Answers an empty list for a missing, unreadable or unparseable file —
/// a session with no MCP servers is the resting state, and failing the spawn
/// over a config file fx itself would tolerate would be worse than the bug
/// this fixes.
pub async fn configured_servers() -> Vec<Value> {
    let Some(path) = config_path() else {
        return Vec::new();
    };
    let Ok(bytes) = tokio::fs::read(path).await else {
        return Vec::new();
    };
    let Ok(config) = serde_json::from_slice::<ConfigFile>(&bytes) else {
        return Vec::new();
    };

    let mut secrets = Secrets::default();
    for key in referenced_env(&config) {
        if let Some(value) = resolve_env(&key).await {
            secrets.env.insert(key, value);
        }
    }
    secrets.auth = auth_states().await;
    secrets.linear_key = read_key(IssueTracker::Linear).await;

    to_acp(config, &secrets)
}

/// Every environment variable the config names, so each is resolved once.
fn referenced_env(config: &ConfigFile) -> BTreeSet<String> {
    config
        .mcp
        .values()
        .filter_map(|v| serde_json::from_value::<ServerConfig>(v.clone()).ok())
        .flat_map(|s| {
            s.header_env
                .into_values()
                .chain(s.bearer_token_env)
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The process environment first, then the login shell's.
///
/// A bundled `.app` launched from Finder or the Dock inherits launchd's
/// environment, which holds nothing a reader exported from `.zprofile` — the
/// same trap `binpath` walks for `PATH`. Asking the login shell is what makes
/// a `bearer_token_env` that works in the reader's `fx` shell work here too.
async fn resolve_env(key: &str) -> Option<String> {
    if let Ok(value) = std::env::var(key) {
        return Some(value);
    }
    login_shell_var(key).await
}

/// `printenv` inside the user's login shell. The name rides as `$1`, never
/// interpolated into the command string, and is checked against a variable's
/// grammar first — it comes out of a config file.
async fn login_shell_var(key: &str) -> Option<String> {
    let valid = !key.is_empty()
        && !key.starts_with(|c: char| c.is_ascii_digit())
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid {
        return None;
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let output = Command::new(shell)
        .args(["-l", "-c", "printenv \"$1\"", "_", key])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }

    // The last line: a profile that echoes on login puts its chatter first.
    let stdout = String::from_utf8(output.stdout).ok()?;
    stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}

/// Server name → fx's own `auth=` reading, off `fx mcp list`.
///
/// No `--connect`, so nothing is opened and nothing leaves the machine; the
/// state comes from fx's credential store. Run from home rather than the
/// session's cwd so a project-scoped `.mcp.json` cannot answer for a profile
/// server of the same name. A failed probe answers empty, which every caller
/// reads as "skip" — the safe direction.
async fn auth_states() -> BTreeMap<String, String> {
    let bin = crate::binpath::fx().await;
    let mut command = Command::new(&bin);
    command.args(["mcp", "list"]);
    if let Some(home) = std::env::home_dir() {
        command.current_dir(home);
    }
    let output = command
        .env("PATH", crate::harness::agent_path(&bin))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await;
    match output {
        Ok(output) if output.status.success() => {
            parse_auth_states(&String::from_utf8_lossy(&output.stdout))
        }
        _ => BTreeMap::new(),
    }
}

/// A server's line opens with its name and carries `key=value` fields; the
/// indented lines under it are detail and hold no `source=`.
fn parse_auth_states(listing: &str) -> BTreeMap<String, String> {
    listing
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let name = fields.next()?;
            let mut fields = fields.peekable();
            fields.peek()?.strip_prefix("source=")?;
            let auth = fields.find_map(|f| f.strip_prefix("auth="))?;
            Some((name.to_string(), auth.to_string()))
        })
        .collect()
}

/// The mapping, with every secret passed in so it is testable with nothing
/// spawned and nothing read.
fn to_acp(config: ConfigFile, secrets: &Secrets) -> Vec<Value> {
    config
        .mcp
        .into_iter()
        // A shape this build cannot read costs that entry alone.
        .filter_map(|(name, value)| {
            serde_json::from_value::<ServerConfig>(value)
                .ok()
                .map(|server| (name, server))
        })
        // Absent means on, which is how fx reads it; only an explicit `false`
        // is a disabled server.
        .filter(|(_, server)| server.enabled.unwrap_or(true))
        .filter_map(|(name, server)| server_to_acp(&name, server, secrets))
        .collect()
}

fn server_to_acp(name: &str, server: ServerConfig, secrets: &Secrets) -> Option<Value> {
    match server.r#type.as_deref() {
        Some(kind @ ("http" | "sse")) => {
            let url = server.url.clone()?;
            let headers = headers_for(name, &url, &server, secrets)?;
            Some(json!({"type": kind, "name": name, "url": url, "headers": headers}))
        }
        // Absent is stdio, fx's own default for a server added with a command.
        None | Some("stdio") => {
            let command = server.command?;
            let env: Vec<Value> = server
                .env
                .into_iter()
                .map(|(name, value)| json!({"name": name, "value": value}))
                .collect();
            Some(json!({"name": name, "command": command, "args": server.args, "env": env}))
        }
        // A transport this build does not know. Skipping costs that server;
        // guessing at its shape costs the session.
        Some(_) => None,
    }
}

/// The headers to hand over, or `None` where the server cannot be — which is
/// the signal to skip it entirely.
///
/// Answers as ACP's `[{name, value}]` array, never an object: fx validates the
/// shape and refuses a map with "MCP server headers must be valid unique
/// name/value string entries". An empty array is a real answer, for a server
/// fx reports no credentials for; a headerless server fx *does* hold
/// credentials for is OAuth-backed and cannot be served from here — unless it
/// is Linear's, where Dray's own key stands in.
fn headers_for(
    name: &str,
    url: &str,
    server: &ServerConfig,
    secrets: &Secrets,
) -> Option<Vec<Value>> {
    let mut headers: BTreeMap<String, String> = server.headers.clone();

    for (header, key) in &server.header_env {
        // A named variable that is not set is a missing credential, not an
        // empty one — sending a blank header would turn a skip into a session
        // that fails to open.
        headers.insert(header.clone(), secrets.env.get(key)?.clone());
    }

    if let Some(key) = &server.bearer_token_env {
        headers.insert(
            "Authorization".to_string(),
            format!("Bearer {}", secrets.env.get(key)?),
        );
    }

    // The reader's own config wins; Dray's key fills the gap only where the
    // config named no credential at all.
    if headers.is_empty() && is_linear_mcp(url) {
        if let Some(key) = &secrets.linear_key {
            headers.insert("Authorization".to_string(), format!("Bearer {key}"));
        }
    }

    if headers.is_empty() && secrets.auth.get(name).map(String::as_str) != Some("none") {
        return None;
    }

    Some(
        headers
            .into_iter()
            .map(|(name, value)| json!({"name": name, "value": value}))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> ConfigFile {
        serde_json::from_str(json).expect("fixture parses")
    }

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn nothing() -> Secrets {
        Secrets::default()
    }

    fn with_env(pairs: &[(&str, &str)]) -> Secrets {
        Secrets {
            env: map(pairs),
            ..Secrets::default()
        }
    }

    fn with_auth(pairs: &[(&str, &str)]) -> Secrets {
        Secrets {
            auth: map(pairs),
            ..Secrets::default()
        }
    }

    fn with_linear_key(key: &str) -> Secrets {
        Secrets {
            linear_key: Some(key.to_string()),
            ..Secrets::default()
        }
    }

    /// `fx mcp add --transport http` + `fx mcp auth`, verbatim.
    const LINEAR: &str = r#"{"mcp":{"linear-server":{"type":"http","url":"https://mcp.linear.app/mcp","enabled":true,"startup_timeout_ms":30000,"operation_timeout_ms":60000}}}"#;

    /// The shape fx accepts for a stdio server, pinned end to end: `env` is a
    /// name/value **array**, not the map fx writes it as, and `args` is always
    /// present. Verified live — the tool listed, ran, and read the env entry.
    #[test]
    fn stdio_server_takes_acps_shape() {
        let servers = to_acp(
            parse(
                r#"{"mcp":{"probe":{"command":"node","args":["s.mjs"],"env":{"TOKEN":"t"}}}}"#,
            ),
            &nothing(),
        );

        assert_eq!(
            servers,
            vec![json!({
                "name": "probe",
                "command": "node",
                "args": ["s.mjs"],
                "env": [{"name": "TOKEN", "value": "t"}],
            })]
        );
    }

    /// `headers` must be an array of name/value entries — fx refuses an object
    /// map outright, so a regression here fails every HTTP server at once.
    #[test]
    fn http_server_carries_headers_as_an_array() {
        let servers = to_acp(
            parse(
                r#"{"mcp":{"api":{"type":"http","url":"https://e.test/mcp","headers":{"Authorization":"Bearer t"}}}}"#,
            ),
            &nothing(),
        );

        assert_eq!(
            servers,
            vec![json!({
                "type": "http",
                "name": "api",
                "url": "https://e.test/mcp",
                "headers": [{"name": "Authorization", "value": "Bearer t"}],
            })]
        );
    }

    /// The motivating case, and the one server Dray can answer for itself:
    /// with the Issues panel connected, the reader's own Linear key rides as
    /// the bearer. Verified live — 66 tools where the same session answered
    /// `NO-MCP-TOOLS` with the key withheld.
    #[test]
    fn linear_goes_over_with_drays_own_key() {
        let servers = to_acp(parse(LINEAR), &with_linear_key("lin_api_k"));

        assert_eq!(
            servers,
            vec![json!({
                "type": "http",
                "name": "linear-server",
                "url": "https://mcp.linear.app/mcp",
                "headers": [{"name": "Authorization", "value": "Bearer lin_api_k"}],
            })]
        );
    }

    /// With no key stored, Linear is an OAuth-backed server like any other:
    /// fx will not lend its credentials, and passing it fails the whole
    /// `session/new`, so it is **skipped**. fx's own reading says so.
    #[test]
    fn linear_with_no_key_is_skipped_not_passed() {
        assert!(to_acp(parse(LINEAR), &with_auth(&[("linear-server", "authenticated")])).is_empty());
        // A probe that answered nothing reads the same way: skip.
        assert!(to_acp(parse(LINEAR), &nothing()).is_empty());
    }

    /// The key goes to Linear's host and nowhere else. The URL is config text,
    /// so the host is compared parsed and whole: a look-alike, a subdomain
    /// carrying the real name as a prefix, and plain http are all refused.
    #[test]
    fn drays_key_is_sent_to_linears_host_alone() {
        for url in [
            "https://mcp.linear.app.evil.test/mcp",
            "https://evil.test/mcp.linear.app",
            "http://mcp.linear.app/mcp",
            "https://linear.app/mcp",
        ] {
            let config = parse(&format!(r#"{{"mcp":{{"x":{{"type":"http","url":"{url}"}}}}}}"#));
            assert!(to_acp(config, &with_linear_key("k")).is_empty(), "{url}");
        }
        assert!(is_linear_mcp("https://mcp.linear.app/mcp/readonly"));
    }

    /// A header the reader wrote outranks Dray's key — they chose it, and a
    /// read-only key of their own is a real choice a stronger one must not
    /// override.
    #[test]
    fn a_configured_header_outranks_drays_key() {
        let config = parse(
            r#"{"mcp":{"linear-server":{"type":"http","url":"https://mcp.linear.app/mcp","headers":{"Authorization":"Bearer theirs"}}}}"#,
        );

        assert_eq!(
            to_acp(config, &with_linear_key("drays"))[0]["headers"],
            json!([{"name": "Authorization", "value": "Bearer theirs"}])
        );
    }

    /// A headerless server fx holds no credentials for is an endpoint that
    /// wants none, and goes over with an empty header list — which fx requires
    /// to be present.
    #[test]
    fn a_headerless_server_fx_holds_no_credentials_for_goes_over_with_empty_headers() {
        let servers = to_acp(
            parse(r#"{"mcp":{"local":{"type":"http","url":"http://127.0.0.1:8787/mcp"}}}"#),
            &with_auth(&[("local", "none")]),
        );

        assert_eq!(
            servers,
            vec![json!({
                "type": "http",
                "name": "local",
                "url": "http://127.0.0.1:8787/mcp",
                "headers": [],
            })]
        );
    }

    /// `fx mcp list`'s own output, captured. The name opens the line, the
    /// detail lines under it carry no `source=` and must not read as servers.
    #[test]
    fn auth_states_are_read_off_fx_mcp_list() {
        let listing = "MCP health (2 servers):\n  \
            linear-server source=profile scope=profile policy=optional transport=http state=disconnected auth=authenticated\n    \
            negotiated_name=unavailable negotiated_version=unavailable protocol=unavailable\n    \
            tools=unknown resources=unknown templates=unknown prompts=unknown cache=unavailable subscription=unavailable\n    \
            retry_attempt=0 retry_in_ms=none discovery=pending\n  \
            local source=profile scope=profile policy=optional transport=stdio state=disconnected auth=none\n    \
            negotiated_name=unavailable negotiated_version=unavailable protocol=unavailable\n";

        assert_eq!(
            parse_auth_states(listing),
            map(&[("linear-server", "authenticated"), ("local", "none")])
        );
        assert!(parse_auth_states("No MCP servers configured.\n").is_empty());
    }

    /// A stdio server beside it still goes over, so one server Dray cannot
    /// authenticate never costs the others.
    #[test]
    fn one_skipped_server_does_not_take_the_rest_with_it() {
        let servers = to_acp(
            parse(
                r#"{"mcp":{
                    "oauth-thing":{"type":"http","url":"https://mcp.example.test/mcp"},
                    "files":{"command":"mcp-fs"}
                }}"#,
            ),
            &nothing(),
        );

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "files");
    }

    /// Both env-sourced spellings fx has, and the rule that an unset variable
    /// skips the server rather than sending a blank credential.
    #[test]
    fn env_sourced_headers_resolve_and_a_missing_one_skips() {
        let bearer = r#"{"mcp":{"api":{"type":"http","url":"https://e.test","bearer_token_env":"TOK"}}}"#;
        let named = r#"{"mcp":{"api":{"type":"http","url":"https://e.test","header_env":{"X-Key":"TOK"}}}}"#;

        let present = with_env(&[("TOK", "secret")]);

        assert_eq!(
            to_acp(parse(bearer), &present)[0]["headers"],
            json!([{"name": "Authorization", "value": "Bearer secret"}])
        );
        assert_eq!(
            to_acp(parse(named), &present)[0]["headers"],
            json!([{"name": "X-Key", "value": "secret"}])
        );

        assert!(to_acp(parse(bearer), &nothing()).is_empty());
        assert!(to_acp(parse(named), &nothing()).is_empty());
    }

    /// Every variable the config names, once, so a login shell is asked at
    /// most once per name however many servers share it.
    #[test]
    fn referenced_env_is_the_union_of_both_spellings() {
        let config = parse(
            r#"{"mcp":{
                "a":{"type":"http","url":"https://a","bearer_token_env":"TOK"},
                "b":{"type":"http","url":"https://b","header_env":{"X-A":"TOK","X-B":"OTHER"}}
            }}"#,
        );

        let keys: Vec<_> = referenced_env(&config).into_iter().collect();
        assert_eq!(keys, vec!["OTHER", "TOK"]);
    }

    /// Only an explicit `false` disables a server; absent means on, which is
    /// how fx reads the same field.
    #[test]
    fn only_an_explicit_false_disables_a_server() {
        let servers = to_acp(
            parse(
                r#"{"mcp":{
                    "off":{"command":"a","enabled":false},
                    "on":{"command":"b","enabled":true},
                    "unsaid":{"command":"c"}
                }}"#,
            ),
            &nothing(),
        );

        let names: Vec<_> = servers.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["on", "unsaid"]);
    }

    /// A transport this build has never heard of, a server missing the one
    /// field its transport needs, and an entry whose field fx has changed the
    /// shape of each cost that server alone — never the file.
    #[test]
    fn a_bad_entry_costs_itself_and_nothing_else() {
        let servers = to_acp(
            parse(
                r#"{"mcp":{
                    "future":{"type":"websocket","url":"wss://e.test"},
                    "urlless":{"type":"http","headers":{"a":"b"}},
                    "commandless":{"args":["x"]},
                    "reshaped":{"command":"x","headers":[{"name":"a","value":"b"}]},
                    "stringy":{"command":"y","enabled":"yes"},
                    "good":{"command":"ok"}
                }}"#,
            ),
            &nothing(),
        );

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "good");
    }

    /// What this machine's own `~/.fx/mcp.json` maps to, printed rather than
    /// asserted, **header values masked** — one of them may be a key.
    /// Everything above reads a fixture, so it proves the mapping and nothing
    /// about whether the reader's real file still parses through it — which is
    /// the half a new fx release can break. Ignored by default: the answer is
    /// whatever this machine happens to be configured with.
    ///
    /// Read it beside `fx mcp list`: a server healthy there and absent here is
    /// one Dray is skipping, and for an `auth=authenticated` HTTP server other
    /// than Linear's that is the documented outcome, not a defect.
    #[tokio::test]
    #[ignore]
    async fn what_the_installed_fx_config_maps_to() {
        for mut server in configured_servers().await {
            if let Some(headers) = server["headers"].as_array_mut() {
                for header in headers {
                    header["value"] = json!("<masked>");
                }
            }
            println!("  {server}");
        }
    }

    /// fx's file is free to gain keys, and one this build cannot spell must
    /// cost nothing — `startup_timeout_ms` and friends already ride along.
    #[test]
    fn unknown_config_keys_are_ignored_rather_than_failing_the_file() {
        let servers = to_acp(
            parse(
                r#"{"mcp":{"probe":{"command":"node","policy":"optional","restart_limit":3,"trust":"approved"}},"schema_version":9}"#,
            ),
            &nothing(),
        );

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "probe");
    }
}
