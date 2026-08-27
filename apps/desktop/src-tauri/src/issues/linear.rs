//! Linear, over its GraphQL API.
//!
//! The one file in the app that talks to a service directly rather than
//! shelling out to a CLI the way `gh` and `claude` are reached — Linear ships
//! no CLI to borrow auth from, so the key is ours to hold and the wire is ours
//! to parse. Everything it answers is turned into the vocabulary next door
//! before it leaves; nothing above this file knows a `LinearIssue` exists.
//!
//! **Two wire facts shape the whole module.** A failed GraphQL query answers
//! `200` with `{"data":null,"errors":[…]}`, so the status code proves nothing
//! and `errors` is checked first — the same trap [`github`](crate::github)
//! documents. And every field is read *out of a `Value`* rather than derived
//! onto a struct: a schema Linear extends must cost one absent field, never a
//! whole list that fails to deserialize and leaves the page empty.

use std::{sync::OnceLock, time::Duration};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};

use super::{
    Issue, IssueAsset, IssueComment, IssueDetail, IssueFilters, IssueGroup, IssueLabel, IssuePerson,
    IssuePriority, IssueQuery, IssueScope, IssueState, IssueStateKind, IssueTracker,
    IssueUnavailable, TrackerAccount,
};

const API: &str = "https://api.linear.app/graphql";

/// Long enough for a cold query against a large workspace, short enough that a
/// picker keystroke cannot hang the composer's list for a minute.
const TIMEOUT: Duration = Duration::from_secs(20);

/// Shared, because a `Client` owns the connection pool: minting one per
/// keystroke would open a TLS connection per keystroke.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!("Dray/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client")
    })
}

/// One query, with the errors already read.
///
/// The key travels in `Authorization` bare, not as a `Bearer` — that is how
/// Linear takes a *personal* key, and the OAuth spelling is refused.
async fn query(key: &str, document: &str, variables: Value) -> Result<Value, IssueUnavailable> {
    let response = client()
        .post(API)
        .header("Authorization", key)
        .json(&json!({ "query": document, "variables": variables }))
        .send()
        .await
        .map_err(|e| IssueUnavailable::Offline(e.to_string()))?;

    let status = response.status();
    // Read before branching on the status: an error body is where Linear says
    // *why*, and a 400 with a readable sentence beats "400" on its own.
    let body: Value = response.json().await.unwrap_or(Value::Null);

    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(IssueUnavailable::Unauthorized);
    }

    if let Some(message) = first_error(&body) {
        // Linear reports a bad key as an ordinary GraphQL error too, so the
        // sentence is what tells the two apart at 200.
        let lower = message.to_lowercase();
        if lower.contains("authentication") || lower.contains("unauthorized") {
            return Err(IssueUnavailable::Unauthorized);
        }
        return Err(IssueUnavailable::Other(message));
    }

    if !status.is_success() {
        return Err(IssueUnavailable::Other(format!("Linear answered {status}")));
    }

    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

fn first_error(body: &Value) -> Option<String> {
    let errors = body.get("errors")?.as_array()?;
    let first = errors.first()?;

    Some(
        first
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Linear rejected the query")
            .to_string(),
    )
}

// ── queries ──────────────────────────────────────────────────────────────────

/// Who the key belongs to. Also what validates it: there is no cheaper call,
/// and it answers with everything the settings row draws.
const VIEWER: &str = r#"
query{viewer{id name organization{name}}}
"#;

/// Every field a row draws, and none it doesn't — no description and no
/// comments, which are [`ISSUE`]'s and cost the better part of the payload.
const ISSUES: &str = r#"
query($filter:IssueFilter,$first:Int!){
 issues(filter:$filter,first:$first,orderBy:updatedAt){nodes{
  id identifier title url priority updatedAt
  state{name type color}
  assignee{name avatarUrl}
  labels(first:10){nodes{name color}}
  team{key}
  project{name}
 }}}
"#;

/// The same issue by its stable id, which is what a link records.
///
/// Tried first wherever one is held, because the identifier is not stable:
/// moving an issue to another team renumbers it, `DRA-53` becomes `ENG-12`, and
/// a lookup by the recorded spelling then answers "no such issue" for work that
/// is very much still there. The UUID survives that move.
const ISSUE_BY_ID: &str = r#"
query($id:String!){
 issue(id:$id){
  id identifier title url priority updatedAt description
  state{name type color}
  assignee{name avatarUrl}
  labels(first:10){nodes{name color}}
  team{key}
  project{name}
  comments(first:50){nodes{body createdAt url user{name avatarUrl}}}
 }}
"#;

/// One issue, opened by its human identifier.
///
/// Looked up by team key and number rather than by handing the identifier to
/// `issue(id:)`: that argument is the UUID, and whether it also resolves a
/// human identifier is a convenience nothing in the schema promises. A filter
/// on the two halves is exactly as precise and is documented.
const ISSUE: &str = r#"
query($key:String!,$number:Float!){
 issues(filter:{team:{key:{eq:$key}},number:{eq:$number}},first:1){nodes{
  id identifier title url priority updatedAt description
  state{name type color}
  assignee{name avatarUrl}
  labels(first:10){nodes{name color}}
  team{key}
  project{name}
  comments(first:50){nodes{body createdAt url user{name avatarUrl}}}
 }}}
"#;

/// Where Linear serves uploaded files. Checked before anything is fetched with
/// the key attached: this command takes a URL out of an issue's own markdown,
/// and markdown is text somebody else wrote — so without this, an issue
/// description could name any host it liked and have the app post a credential
/// to it. The key travels to Linear or nowhere.
const UPLOADS_HOST: &str = "uploads.linear.app";

/// Whether `url` is one of Linear's own uploads, over HTTPS, host-exactly.
///
/// Compared against the parsed host rather than by `starts_with` on the string:
/// `https://uploads.linear.app.evil.test/x` passes a prefix test and is not
/// Linear, and that is the whole point of the check.
///
/// The scheme is half of it, and the half that is easy to leave out. A host
/// check alone accepts `http://uploads.linear.app/…`, and that request carries
/// the key in cleartext for anyone on the path to read — an issue description is
/// text somebody else wrote, so naming the right host over the wrong scheme is
/// one line of markdown away. Rejected rather than upgraded to HTTPS: rewriting
/// a URL somebody else supplied to make it acceptable is a guess about what they
/// meant, and Linear's own uploads are HTTPS.
pub fn is_upload(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .map(|parsed| parsed.scheme() == "https" && parsed.host_str() == Some(UPLOADS_HOST))
        .unwrap_or(false)
}

/// One uploaded file as a `data:` URL.
pub async fn fetch_asset(
    key: &str,
    url: &str,
    max_bytes: u64,
) -> Result<IssueAsset, IssueUnavailable> {
    if !is_upload(url) {
        return Err(IssueUnavailable::Other(
            "that file is not hosted by Linear".into(),
        ));
    }

    let response = client()
        .get(url)
        .header("Authorization", key)
        .send()
        .await
        .map_err(|e| IssueUnavailable::Offline(e.to_string()))?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(IssueUnavailable::Unauthorized);
    }
    if !status.is_success() {
        return Err(IssueUnavailable::Other(format!("Linear answered {status}")));
    }

    // The advertised length first, so an oversized file is refused before its
    // body is read rather than after — the same reading `cat-file --batch-check`
    // exists for on the git side. A server that sends no length is still capped
    // below, on what actually arrived.
    if let Some(len) = response.content_length() {
        if len > max_bytes {
            return Err(IssueUnavailable::Other("that file is too large".into()));
        }
    }

    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        // Split on `;` because the header carries charset with it, and a
        // `data:` URL wants the type alone.
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
        .filter(|mime| !mime.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());

    // Streamed rather than `.bytes()`, and that is the cap actually being
    // enforced. The advertised length above is a courtesy — a server may send
    // none, or send one that lies — and `.bytes()` drains the whole body into
    // memory *before* anything could reject it, so a file with no
    // `Content-Length` was read in full however large it was. Same reading
    // `cat-file --batch-check` exists for on the git side: refuse on the way in,
    // not after.
    let mut body: Vec<u8> = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| IssueUnavailable::Offline(e.to_string()))?
    {
        if body.len() as u64 + chunk.len() as u64 > max_bytes {
            return Err(IssueUnavailable::Other("that file is too large".into()));
        }
        body.extend_from_slice(&chunk);
    }

    Ok(IssueAsset {
        data_url: format!("data:{mime};base64,{}", BASE64.encode(&body)),
        mime,
        bytes: body.len() as u64,
    })
}

/// The filter row's options. Archived teams and projects are left out by
/// Linear's own defaults, which is the right way round — a filter offering a
/// team nobody works in is a row to skip past.
const FILTERS: &str = r#"
query{
 teams(first:100){nodes{id name}}
 projects(first:100){nodes{id name}}}
"#;

/// Validates `key` and answers with whose it is.
pub async fn verify(key: &str) -> Result<TrackerAccount, IssueUnavailable> {
    let data = query(key, VIEWER, json!({})).await?;
    let viewer = data
        .get("viewer")
        .ok_or_else(|| IssueUnavailable::Other("Linear answered with no account".into()))?;

    Ok(TrackerAccount {
        tracker: IssueTracker::Linear,
        user_id: text(viewer, "id"),
        user_name: text(viewer, "name"),
        org_name: viewer
            .get("organization")
            .map(|org| text(org, "name"))
            .unwrap_or_default(),
    })
}

/// Issues matching `query`, most urgent first.
///
/// Sorted here rather than by the API. Linear orders by `createdAt` or
/// `updatedAt` and nothing else, and "what should I pick up" is a priority
/// question — so the API's own order is asked for as the *tiebreak* (newest
/// touched first) and the levels are applied over it.
pub async fn list_issues(
    key: &str,
    filters: &IssueQuery,
    limit: usize,
) -> Result<Vec<Issue>, IssueUnavailable> {
    let data = query(
        key,
        ISSUES,
        json!({ "filter": build_filter(filters), "first": limit.clamp(1, 250) }),
    )
    .await?;

    let mut issues = nodes(&data, "issues")
        .iter()
        .filter_map(map_issue)
        .collect::<Vec<_>>();

    // Stable, so the API's newest-first order survives inside a level. Only on
    // the unfinished half: priority on a closed issue is a fact about a decision
    // already taken, and sorting by it buries the thing that just landed.
    if !filters.settled {
        issues.sort_by_key(|issue| issue.priority.rank());
    }

    Ok(issues)
}

/// One issue, with its description and comments.
///
/// `id` is the stable id off a link that was resolved once, and it is tried
/// first: the identifier renumbers when an issue moves team, so a session linked
/// to `DRA-53` that has since become `ENG-12` reads as an issue that no longer
/// exists. The identifier is the fallback and not the other way round because it
/// is the *only* thing a blind link carries — `dray issue link DRA-53` writes the
/// identifier into both fields, so an `id` that is not a UUID names nothing on
/// Linear's side and is skipped rather than asked about.
///
/// A UUID lookup that comes back empty falls through to the identifier too. The
/// two disagree only for a link written against an issue since deleted, which is
/// a corner worth answering with whatever is live rather than with nothing.
pub async fn get_issue(
    key: &str,
    identifier: &str,
    id: Option<&str>,
) -> Result<IssueDetail, IssueUnavailable> {
    if let Some(id) = id.filter(|id| is_stable_id(id)) {
        match query(key, ISSUE_BY_ID, json!({ "id": id })).await {
            Ok(data) => {
                if let Some(node) = data.get("issue").filter(|node| !node.is_null()) {
                    return read_detail(node, identifier);
                }
            }
            // Not fatal: the identifier below is a second way to ask the same
            // question, and answering it beats reporting the first attempt.
            Err(e) => eprintln!("[issue {identifier}] by id: {e:?}"),
        }
    }

    let (team, number) = split_identifier(identifier).ok_or_else(|| {
        IssueUnavailable::Other(format!("{identifier} is not an issue identifier"))
    })?;

    let data = query(key, ISSUE, json!({ "key": team, "number": number })).await?;

    let node = nodes(&data, "issues")
        .first()
        .cloned()
        .ok_or_else(|| IssueUnavailable::Other(format!("No issue {identifier}")))?;

    read_detail(&node, identifier)
}

/// Whether `id` is Linear's own id rather than an identifier a blind link wrote
/// into the same field. A UUID and a `DRA-53` cannot be confused for each other,
/// which is the property `unlink_session_issue` already leans on.
fn is_stable_id(id: &str) -> bool {
    id.len() == 36
        && id.split('-').map(str::len).eq([8, 4, 4, 4, 12])
        && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn read_detail(node: &Value, identifier: &str) -> Result<IssueDetail, IssueUnavailable> {
    let issue = map_issue(node)
        .ok_or_else(|| IssueUnavailable::Other(format!("Could not read {identifier}")))?;

    Ok(IssueDetail {
        issue,
        // Linear sends an empty string for an issue nobody wrote a description
        // for, and an empty box on screen says less than a sentence saying so.
        description: node
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|body| !body.is_empty())
            .map(str::to_string),
        comments: map_comments(node),
    })
}

pub async fn list_filters(key: &str) -> Result<IssueFilters, IssueUnavailable> {
    let data = query(key, FILTERS, json!({})).await?;

    Ok(IssueFilters {
        teams: map_groups(&data, "teams"),
        projects: map_groups(&data, "projects"),
    })
}

// ── building the filter ──────────────────────────────────────────────────────

/// [`IssueQuery`] as Linear's `IssueFilter`.
///
/// Every clause is additive and every one is optional, so the resting state —
/// assigned to me, not yet finished — is what an empty query produces. Text is
/// matched against the title *or* the description: an issue is usually found by
/// a word in its body, and searching titles alone reads as the picker not
/// finding issues that plainly exist.
fn build_filter(query: &IssueQuery) -> Value {
    let mut filter = serde_json::Map::new();

    match query.scope {
        IssueScope::Assigned => {
            filter.insert("assignee".into(), json!({ "isMe": { "eq": true } }));
        }
        IssueScope::Created => {
            filter.insert("creator".into(), json!({ "isMe": { "eq": true } }));
        }
        IssueScope::All => {}
    }

    // Always one side or the other, never both. `in` on the settled read rather
    // than dropping the clause: an unbounded read would hand the page the whole
    // workspace to filter down to two groups it drew collapsed.
    let settled = ["completed", "canceled"];
    filter.insert(
        "state".into(),
        if query.settled {
            json!({ "type": { "in": settled } })
        } else {
            json!({ "type": { "nin": settled } })
        },
    );

    if let Some(team) = query.team_id.as_deref().filter(|id| !id.is_empty()) {
        filter.insert("team".into(), json!({ "id": { "eq": team } }));
    }

    if let Some(project) = query.project_id.as_deref().filter(|id| !id.is_empty()) {
        filter.insert("project".into(), json!({ "id": { "eq": project } }));
    }

    if let Some(text) = query
        .text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        // An identifier typed in full is an address, not a search: `DRA-53`
        // should reach DRA-53 rather than every issue mentioning it. Matched
        // alongside the text clauses rather than instead of them, since a
        // half-typed key is still prose.
        let mut any = vec![
            json!({ "title": { "containsIgnoreCase": text } }),
            json!({ "description": { "containsIgnoreCase": text } }),
        ];

        if let Some((team, number)) = split_identifier(text) {
            any.push(json!({ "team": { "key": { "eq": team } }, "number": { "eq": number } }));
        }

        filter.insert("or".into(), Value::Array(any));
    }

    Value::Object(filter)
}

/// `DRA-53` → `("DRA", 53)`. `None` for anything that isn't one, which is what
/// keeps a half-typed query out of the identifier clause.
fn split_identifier(text: &str) -> Option<(String, f64)> {
    let (key, number) = text.trim().split_once('-')?;
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }

    Some((key.to_uppercase(), number.parse::<u32>().ok()? as f64))
}

// ── wire → vocabulary ────────────────────────────────────────────────────────

/// A connection's `nodes`, or nothing. Every connection Linear answers with is
/// nullable, so this being tolerant is what keeps an issue with no labels from
/// costing the row it is on.
fn nodes<'a>(parent: &'a Value, field: &str) -> &'a [Value] {
    parent
        .get(field)
        .and_then(|c| c.get("nodes"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn text(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn optional(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `None` only for a node missing its identifier — a row that cannot be
/// addressed is one no tag could ever reach, so it is dropped rather than drawn.
/// Everything else degrades to a default, which costs a field on screen and not
/// the read.
fn map_issue(node: &Value) -> Option<Issue> {
    let identifier = optional(node, "identifier")?;

    Some(Issue {
        tracker: IssueTracker::Linear,
        id: text(node, "id"),
        identifier,
        title: text(node, "title"),
        url: text(node, "url"),
        state: map_state(node.get("state")),
        priority: IssuePriority::from_wire(
            node.get("priority").and_then(Value::as_f64).unwrap_or(0.0) as i64,
        ),
        assignee: node.get("assignee").and_then(map_person),
        labels: nodes(node, "labels")
            .iter()
            .map(|label| IssueLabel {
                name: text(label, "name"),
                color: text(label, "color"),
            })
            .collect(),
        team: node.get("team").map(|team| text(team, "key")),
        project: node.get("project").map(|project| text(project, "name")),
        updated_at: text(node, "updatedAt"),
    })
}

/// An issue always has a state; a *missing* one is a schema surprise, and
/// "Unknown" on one row says more than a dropped row does.
fn map_state(value: Option<&Value>) -> IssueState {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return IssueState {
            name: "Unknown".into(),
            kind: IssueStateKind::Other,
            color: String::new(),
        };
    };

    IssueState {
        name: text(value, "name"),
        kind: match value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "triage" => IssueStateKind::Triage,
            "backlog" => IssueStateKind::Backlog,
            "unstarted" => IssueStateKind::Unstarted,
            "started" => IssueStateKind::Started,
            "completed" => IssueStateKind::Completed,
            "canceled" => IssueStateKind::Canceled,
            _ => IssueStateKind::Other,
        },
        color: text(value, "color"),
    }
}

fn map_person(value: &Value) -> Option<IssuePerson> {
    if value.is_null() {
        return None;
    }

    Some(IssuePerson {
        name: text(value, "name"),
        avatar: optional(value, "avatarUrl"),
    })
}

/// Oldest first, which is reading order — the same order the PR panel puts a
/// review thread in.
fn map_comments(node: &Value) -> Vec<IssueComment> {
    let mut comments: Vec<IssueComment> = nodes(node, "comments")
        .iter()
        .map(|comment| IssueComment {
            author: comment
                .get("user")
                .and_then(map_person)
                // A comment left by an integration has no user on it, and
                // "Unknown" beside the text beats a row with a blank byline.
                .unwrap_or(IssuePerson {
                    name: "Unknown".into(),
                    avatar: None,
                }),
            body: text(comment, "body"),
            created_at: text(comment, "createdAt"),
            url: optional(comment, "url"),
        })
        .collect();

    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    comments
}

fn map_groups(data: &Value, field: &str) -> Vec<IssueGroup> {
    let mut groups: Vec<IssueGroup> = nodes(data, field)
        .iter()
        .filter_map(|node| {
            let id = optional(node, "id")?;
            Some(IssueGroup {
                id,
                name: text(node, "name"),
            })
        })
        .collect();

    // Alphabetical: a filter menu is read by name, and Linear's own order here
    // is by creation, which nobody remembers.
    groups.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape Linear answers a list query with, cut to one node. Hand-written
    /// rather than captured, because a capture would carry a real workspace's
    /// issues into the repo — so the fields here are the ones [`ISSUES`] asks
    /// for, and this test is what keeps the two in step.
    fn node() -> Value {
        json!({
            "id": "3fa1",
            "identifier": "DRA-53",
            "title": "Issue tracker integration",
            "url": "https://linear.app/drayhq/issue/DRA-53",
            "priority": 2.0,
            "updatedAt": "2026-08-27T06:11:15.154Z",
            "description": "Long body the prompt never sees.",
            "state": { "name": "In Progress", "type": "started", "color": "#f2c94c" },
            "assignee": { "name": "Yogesh Dhakal", "avatarUrl": "https://x/y.png" },
            "labels": { "nodes": [{ "name": "Feature", "color": "#bb87fc" }] },
            "team": { "key": "DRA" },
            "project": { "name": "Integrations" },
            "comments": { "nodes": [
                { "body": "second", "createdAt": "2026-08-27T09:00:00.000Z", "url": null,
                  "user": { "name": "A", "avatarUrl": null } },
                { "body": "first", "createdAt": "2026-08-27T08:00:00.000Z", "url": "https://c",
                  "user": { "name": "B", "avatarUrl": null } }
            ]}
        })
    }

    #[test]
    fn an_issue_maps_onto_the_vocabulary() {
        let issue = map_issue(&node()).unwrap();

        assert_eq!(issue.identifier, "DRA-53");
        assert_eq!(issue.priority, IssuePriority::High);
        assert_eq!(issue.state.kind, IssueStateKind::Started);
        assert_eq!(issue.state.name, "In Progress");
        assert_eq!(issue.team.as_deref(), Some("DRA"));
        assert_eq!(issue.project.as_deref(), Some("Integrations"));
        assert_eq!(issue.labels.len(), 1);
        assert_eq!(issue.assignee.unwrap().name, "Yogesh Dhakal");
    }

    /// The point of reading fields out of a `Value`: a node stripped to almost
    /// nothing still draws a row rather than failing the whole list.
    #[test]
    fn a_sparse_node_costs_fields_and_not_the_read() {
        let issue = map_issue(&json!({ "identifier": "DRA-1" })).unwrap();

        assert_eq!(issue.title, "");
        assert_eq!(issue.priority, IssuePriority::None);
        assert_eq!(issue.state.kind, IssueStateKind::Other);
        assert!(issue.assignee.is_none());
        assert!(issue.labels.is_empty());
    }

    #[test]
    fn a_node_with_no_identifier_is_dropped() {
        assert!(map_issue(&json!({ "title": "no address" })).is_none());
    }

    #[test]
    fn comments_come_back_oldest_first() {
        let comments = map_comments(&node());

        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].body, "first");
        assert_eq!(comments[1].body, "second");
    }

    /// The key travels to Linear or nowhere. A description is text somebody
    /// else wrote, and it names the URL this fetch is handed — so without the
    /// host check, an issue could point at any server it liked and have the app
    /// post a credential to it.
    #[test]
    fn only_linears_own_uploads_get_the_key() {
        assert!(is_upload("https://uploads.linear.app/a/b/c.png"));

        // A prefix test passes this one, which is exactly why the check is on
        // the parsed host and not on the string.
        assert!(!is_upload("https://uploads.linear.app.evil.test/x.png"));
        assert!(!is_upload("https://evil.test/?u=uploads.linear.app"));
        // The API host is not the upload host, and neither is a bare path.
        assert!(!is_upload("https://api.linear.app/graphql"));
        assert!(!is_upload("/relative/path.png"));
        assert!(!is_upload("not a url"));
        // Right host, wrong scheme: that request would put the key on the wire
        // in cleartext.
        assert!(!is_upload("http://uploads.linear.app/a/b/c.png"));
    }

    #[test]
    fn only_a_uuid_is_worth_asking_linear_about() {
        // What a resolved link records.
        assert!(is_stable_id("9c1a7f2e-0b64-4c3a-9f1d-7e5b2a8c4d61"));
        // What a blind `dray issue link DRA-53` writes into the same field.
        assert!(!is_stable_id("DRA-53"));
        assert!(!is_stable_id(""));
        // Right shape, wrong alphabet — a lookup on this can only 404.
        assert!(!is_stable_id("9c1a7f2e-0b64-4c3a-9f1d-7e5b2a8c4dzz"));
    }

    #[test]
    fn a_comment_left_by_no_user_still_draws() {
        let comments = map_comments(&json!({
            "comments": { "nodes": [{ "body": "hi", "createdAt": "t", "user": null }] }
        }));

        assert_eq!(comments[0].author.name, "Unknown");
    }

    /// The resting state, and the one most reads use.
    #[test]
    fn the_default_filter_is_mine_and_unfinished() {
        let filter = build_filter(&IssueQuery::default());

        assert_eq!(filter["assignee"]["isMe"]["eq"], true);
        assert_eq!(filter["state"]["type"]["nin"][0], "completed");
        assert_eq!(filter["state"]["type"]["nin"][1], "canceled");
        assert!(filter.get("or").is_none());
    }

    /// The settled read is the *complement*, not a widening — or the page would
    /// have to pull a whole workspace back to fill two collapsed groups.
    #[test]
    fn the_settled_read_asks_for_the_other_half() {
        let filter = build_filter(&IssueQuery {
            settled: true,
            ..Default::default()
        });

        assert_eq!(filter["state"]["type"]["in"][0], "completed");
        assert_eq!(filter["state"]["type"]["in"][1], "canceled");
        assert!(filter["state"]["type"].get("nin").is_none());
    }

    #[test]
    fn widening_drops_the_clauses_that_narrow() {
        let filter = build_filter(&IssueQuery {
            scope: IssueScope::All,
            ..Default::default()
        });

        assert!(filter.get("assignee").is_none());
        assert!(filter.get("creator").is_none());
    }

    /// The two halves of "my issues", and they are exclusive: an issue you
    /// filed and somebody else owns is not one you are working on.
    #[test]
    fn created_asks_about_the_creator_and_not_the_assignee() {
        let filter = build_filter(&IssueQuery {
            scope: IssueScope::Created,
            ..Default::default()
        });

        assert_eq!(filter["creator"]["isMe"]["eq"], true);
        assert!(filter.get("assignee").is_none());
    }

    #[test]
    fn text_matches_title_or_body() {
        let filter = build_filter(&IssueQuery {
            text: Some("worktree".into()),
            ..Default::default()
        });

        let any = filter["or"].as_array().unwrap();
        assert_eq!(any.len(), 2, "no identifier clause for prose");
        assert_eq!(any[0]["title"]["containsIgnoreCase"], "worktree");
        assert_eq!(any[1]["description"]["containsIgnoreCase"], "worktree");
    }

    /// A whole identifier is an address, so it gets a clause of its own —
    /// without it, typing `DRA-53` finds every issue that mentions DRA-53 and
    /// not, reliably, DRA-53.
    #[test]
    fn a_whole_identifier_gets_its_own_clause() {
        let filter = build_filter(&IssueQuery {
            text: Some("dra-53".into()),
            ..Default::default()
        });

        let any = filter["or"].as_array().unwrap();
        assert_eq!(any.len(), 3);
        assert_eq!(any[2]["team"]["key"]["eq"], "DRA");
        assert_eq!(any[2]["number"]["eq"], 53.0);
    }

    #[test]
    fn an_empty_query_adds_no_text_clause() {
        let filter = build_filter(&IssueQuery {
            text: Some("   ".into()),
            ..Default::default()
        });

        assert!(filter.get("or").is_none());
    }

    #[test]
    fn identifiers_split_into_a_key_and_a_number() {
        assert_eq!(split_identifier("DRA-53"), Some(("DRA".into(), 53.0)));
        assert_eq!(split_identifier("dra-53"), Some(("DRA".into(), 53.0)));
        assert_eq!(split_identifier("DRA-"), None);
        assert_eq!(split_identifier("53"), None);
        assert_eq!(split_identifier("DRA-53x"), None);
    }

    /// A 200 carrying `errors` is a *failure*, and the status code says nothing
    /// about it — the one wire fact this module is most likely to be broken by.
    #[test]
    fn errors_are_read_before_data() {
        let body = json!({ "data": null, "errors": [{ "message": "Entity not found" }] });
        assert_eq!(first_error(&body).as_deref(), Some("Entity not found"));

        assert!(first_error(&json!({ "data": { "viewer": {} } })).is_none());
        // An error array with an unfamiliar shape still reads as an error.
        assert!(first_error(&json!({ "errors": [{}] })).is_some());
    }

    #[test]
    fn groups_come_back_alphabetical() {
        let data = json!({ "teams": { "nodes": [
            { "id": "2", "name": "web" },
            { "id": "1", "name": "Dray" }
        ]}});

        let teams = map_groups(&data, "teams");
        assert_eq!(teams[0].name, "Dray");
        assert_eq!(teams[1].name, "web");
    }
}
