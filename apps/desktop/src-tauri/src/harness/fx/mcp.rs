//! fx's own MCP servers, in ACP's shape.
//!
//! **`fx acp` reads no MCP config of its own** — the ACP client owns the list,
//! so `session/new` with `mcpServers: []` is literally "this session has no MCP
//! servers" and fx honours it. That is what left Dray's fx sessions with none
//! while the same machine's `fx` shell had all of them (DRA-220). So the list
//! is read here, off `~/.fx/mcp.json`, the file `fx mcp add` writes and
//! `fx mcp path` names.
//!
//! **Dray forwards only what the user already wrote into their own fx config.**
//! A literal `headers` entry, or a `header_env`/`bearer_token_env` naming an
//! environment variable. fx's OAuth credential store is never read: a server
//! authenticated by `fx mcp auth` keeps its token in the keychain, and fx
//! deliberately refuses to lend those credentials to an ACP-supplied server —
//! one handed over with no usable header fails with "Authentication required;
//! supply an Authorization header in the ACP MCP server configuration", even
//! for a name fx itself holds a live authenticated connection for. Extracting
//! that token and re-injecting it as a header would cross the boundary fx drew,
//! and a snapshot access token would expire with no refresh path anyway.
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

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// `~/.fx/mcp.json`, the path `fx mcp path` prints.
fn config_path() -> Option<PathBuf> {
    Some(std::env::home_dir()?.join(".fx/mcp.json"))
}

/// What fx writes under `mcp`. Every field is optional: this file is fx's, free
/// to gain keys, and one we cannot spell must cost a server rather than the
/// whole list.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ConfigFile {
    mcp: BTreeMap<String, ServerConfig>,
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
    to_acp(config, |key| std::env::var(key).ok())
}

/// The mapping, with the environment passed in so it is testable.
fn to_acp(config: ConfigFile, env: impl Fn(&str) -> Option<String>) -> Vec<Value> {
    config
        .mcp
        .into_iter()
        // Absent means on, which is how fx reads it; only an explicit `false`
        // is a disabled server.
        .filter(|(_, server)| server.enabled.unwrap_or(true))
        .filter_map(|(name, server)| server_to_acp(&name, server, &env))
        .collect()
}

fn server_to_acp(
    name: &str,
    server: ServerConfig,
    env: &impl Fn(&str) -> Option<String>,
) -> Option<Value> {
    match server.r#type.as_deref() {
        Some(kind @ ("http" | "sse")) => {
            // No header is not "send none" — fx refuses an HTTP server outright
            // without one, so an unauthenticated server is one we skip.
            let headers = headers_for(&server, env)?;
            let url = server.url?;
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

/// The headers to hand over, or `None` where the config names no way to
/// authenticate — which is the signal to skip the server entirely.
///
/// Answers as ACP's `[{name, value}]` array, never an object: fx validates the
/// shape and refuses a map with "MCP server headers must be valid unique
/// name/value string entries".
fn headers_for(
    server: &ServerConfig,
    env: &impl Fn(&str) -> Option<String>,
) -> Option<Vec<Value>> {
    let mut headers: BTreeMap<String, String> = server.headers.clone();

    for (header, key) in &server.header_env {
        // A named variable that is not set is a missing credential, not an
        // empty one — sending a blank header would turn a skip into a session
        // that fails to open.
        headers.insert(header.clone(), env(key)?);
    }

    if let Some(key) = &server.bearer_token_env {
        headers.insert("Authorization".to_string(), format!("Bearer {}", env(key)?));
    }

    if headers.is_empty() {
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

    fn no_env(_: &str) -> Option<String> {
        None
    }

    /// The shape fx accepts for a stdio server, pinned end to end: `env` is a
    /// name/value **array**, not the map fx writes it as, and `args` is always
    /// present. Verified live — the tool listed, ran, and read the env entry.
    #[test]
    fn stdio_server_takes_acps_shape() {
        let servers = to_acp(
            parse(
                r#"{"mcp":{"probe":{"command":"node","args":["s.mjs"],"env":{"TOKEN":"t"}}}}"#,
            ),
            no_env,
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
            no_env,
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

    /// The motivating case: an OAuth-authenticated HTTP server carries no
    /// header Dray may fill, and fx will not lend its own credentials. It has
    /// to be **skipped** — passing it fails the whole `session/new`, since
    /// every ACP server is required.
    #[test]
    fn an_unauthenticatable_http_server_is_skipped_not_passed() {
        let servers = to_acp(
            parse(
                // `fx mcp add --transport http` + `fx mcp auth`, verbatim.
                r#"{"mcp":{"linear-server":{"type":"http","url":"https://mcp.linear.app/mcp","enabled":true,"startup_timeout_ms":30000,"operation_timeout_ms":60000}}}"#,
            ),
            no_env,
        );

        assert!(servers.is_empty(), "got {servers:?}");
    }

    /// A stdio server beside it still goes over, so one server Dray cannot
    /// authenticate never costs the others.
    #[test]
    fn one_skipped_server_does_not_take_the_rest_with_it() {
        let servers = to_acp(
            parse(
                r#"{"mcp":{
                    "linear-server":{"type":"http","url":"https://mcp.linear.app/mcp"},
                    "files":{"command":"mcp-fs"}
                }}"#,
            ),
            no_env,
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

        let present = |_: &str| Some("secret".to_string());

        assert_eq!(
            to_acp(parse(bearer), present)[0]["headers"],
            json!([{"name": "Authorization", "value": "Bearer secret"}])
        );
        assert_eq!(
            to_acp(parse(named), present)[0]["headers"],
            json!([{"name": "X-Key", "value": "secret"}])
        );

        assert!(to_acp(parse(bearer), no_env).is_empty());
        assert!(to_acp(parse(named), no_env).is_empty());
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
            no_env,
        );

        let names: Vec<_> = servers.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["on", "unsaid"]);
    }

    /// A transport this build has never heard of, and a server missing the one
    /// field its transport needs, each cost that server alone. Guessing at
    /// either would cost the session.
    #[test]
    fn an_unknown_transport_or_a_missing_field_costs_one_server() {
        let servers = to_acp(
            parse(
                r#"{"mcp":{
                    "future":{"type":"websocket","url":"wss://e.test"},
                    "urlless":{"type":"http","headers":{"a":"b"}},
                    "commandless":{"args":["x"]},
                    "good":{"command":"ok"}
                }}"#,
            ),
            no_env,
        );

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "good");
    }

    /// What this machine's own `~/.fx/mcp.json` maps to, printed rather than
    /// asserted. Everything above reads a fixture, so it proves the mapping and
    /// nothing about whether the reader's real file still parses through it —
    /// which is the half a new fx release can break. Ignored by default: the
    /// answer is whatever this machine happens to be configured with.
    ///
    /// Read it beside `fx mcp list`: a server healthy there and absent here is
    /// one Dray is skipping, and for an `auth=authenticated` HTTP server that
    /// is the documented outcome, not a defect.
    #[tokio::test]
    #[ignore]
    async fn what_the_installed_fx_config_maps_to() {
        for server in configured_servers().await {
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
            no_env,
        );

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "probe");
    }
}
