//! What a tool row says, ported from lib/tools.ts and the parts of lib/diff.ts
//! the row reads (`editSides`, `readRange`, the `+N -M` counts). Logic only: the
//! drawing is [tool_row](crate::tool_row). Kept line for line with the web app,
//! so a label or summary fix there ports as a copy.

use dray_core::events::ToolType;
use serde_json::{Map, Value};

fn object(input: &Value) -> Option<&Map<String, Value>> {
    input.as_object()
}

fn field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    object(input)?.get(key)?.as_str()
}

fn nested<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    object(input)?.get(key).filter(|v| v.is_object())
}

/// The path field a call carries, whatever its harness calls it.
fn path_field(input: &Value) -> Option<&str> {
    ["file_path", "path", "notebook_path", "target_file", "target_directory"].iter().find_map(|k| field(input, k))
}

/// The interesting argument, drawn beside the tool name (`toolSummary`).
pub fn tool_summary(name: &str, tool_type: ToolType, input: &Value) -> Option<String> {
    if name == "Skill" {
        return field(input, "skill").map(str::to_owned);
    }
    if name == "skill" {
        return field(input, "location").and_then(|l| l.rsplit('/').next()).map(str::to_owned);
    }
    if name == "use_tool" {
        return field(input, "tool_name").map(str::to_owned);
    }
    // Ahead of the path: a search scopes itself with a directory and its
    // subject is the pattern.
    if let Some(pattern) = field(input, "pattern").filter(|p| !p.is_empty()) {
        return Some(pattern.to_owned());
    }
    if let Some(path) = path_field(input).filter(|p| !p.is_empty()) {
        return Some(shorten_path(path));
    }
    if let Some(request) = nested(input, "request") {
        return field(request, "task").or_else(|| field(request, "query")).map(str::to_owned);
    }
    let typed = match tool_type {
        ToolType::Shell => field(input, "command"),
        ToolType::Search => field(input, "query"),
        ToolType::Web => field(input, "url").or_else(|| field(input, "query")),
        ToolType::SubagentSpawn => field(input, "description").or_else(|| field(input, "subagent_type")),
        _ => None,
    };
    if let Some(s) = typed {
        return Some(s.to_owned());
    }
    ["description", "command", "query", "prompt"].iter().find_map(|k| field(input, k)).map(str::to_owned)
}

/// `[running, done, noun]` per tool name; a miss falls through to the name.
fn verbs(name: &str) -> Option<[&'static str; 3]> {
    Some(match name {
        "Read" | "read" | "read_file" => ["Reading", "Read", "file"],
        "NotebookRead" => ["Reading", "Read", "notebook"],
        "Edit" | "edit" | "edit_file" | "apply_patch" | "search_replace" => ["Editing", "Edited", "file"],
        "NotebookEdit" => ["Editing", "Edited", "notebook"],
        "Write" | "write" | "write_file" => ["Writing", "Wrote", "file"],
        "Bash" | "shell" | "bash" | "run_terminal_command" => ["Bash", "Bash", "command"],
        "powershell" => ["PowerShell", "PowerShell", "command"],
        "BashOutput" | "get_command_or_subagent_output" => ["Reading output", "Read output", "output"],
        "read_tool_result" => ["Reading output", "Read output", "result"],
        "KillShell" => ["Killing shell", "Killed shell", "shell"],
        "Grep" | "Glob" | "grep" | "find" | "glob_files" | "grep_files" => ["Searching", "Searched", "pattern"],
        "capability_search" => ["Searching", "Searched", "capability"],
        "WebFetch" | "web_fetch" => ["Fetching", "Fetched", "page"],
        "WebSearch" | "web_search" | "search" => ["Searching web", "Searched web", "query"],
        "AskUserQuestion" | "ask_user_question" => ["Asking", "Asked", "question"],
        "Skill" | "skill" => ["Reading Skill", "Read Skill", "skill"],
        "view_image" => ["Viewing", "Viewed", "image"],
        "ls" | "list_dir" => ["Listing", "Listed", "directory"],
        "subagent" | "spawn_subagent" => ["Delegating", "Delegated", "task"],
        "todo_write" | "TodoWrite" => ["Todo", "Todo", "todo list"],
        "kill_command_or_subagent" => ["Stopping", "Stopped", "task"],
        "monitor" => ["Watching", "Watched", "command"],
        "search_tool" => ["Finding tool", "Found tool", "tool"],
        "use_tool" => ["Running", "Ran", "tool"],
        "workflow" => ["Running workflow", "Ran workflow", "workflow"],
        "scheduler_create" => ["Scheduling", "Scheduled", "task"],
        "scheduler_list" => ["Reading schedule", "Read schedule", "schedule"],
        "scheduler_delete" => ["Unscheduling", "Unscheduled", "task"],
        "enter_plan_mode" => ["Entering plan mode", "Entered plan mode", "plan"],
        "exit_plan_mode" => ["Presenting plan", "Presented plan", "plan"],
        _ => return None,
    })
}

/// A single row's label, in the tense `pending` picks (`toolLabel`).
pub fn tool_label(name: &str, pending: bool) -> String {
    match verbs(name) {
        Some(v) => v[if pending { 0 } else { 1 }].to_owned(),
        None => name.to_owned(),
    }
}

fn group_override(name: &str) -> Option<[&'static str; 2]> {
    Some(match name {
        "Bash" | "shell" => ["Running", "Ran"],
        "TodoWrite" | "todo_write" => ["Updating", "Updated"],
        "BashOutput" | "read_tool_result" | "Skill" | "skill" => ["Reading", "Read"],
        "KillShell" => ["Killing", "Killed"],
        "WebSearch" | "web_search" => ["Searching", "Searched"],
        _ => return None,
    })
}

/// The verb a collapsed run reads under (`groupVerb`).
pub fn group_verb(name: &str, pending: bool) -> String {
    let i = if pending { 0 } else { 1 };
    if let Some(o) = group_override(name) {
        return o[i].to_owned();
    }
    verbs(name).map_or_else(|| name.to_owned(), |v| v[i].to_owned())
}

fn plural(noun: &str, count: usize) -> String {
    if count == 1 {
        return noun.to_owned();
    }
    let mut chars = noun.chars().rev();
    let consonant_y = chars.next() == Some('y') && chars.next().is_some_and(|c| !"aeiou".contains(c));
    if consonant_y { format!("{}ies", &noun[..noun.len() - 1]) } else { format!("{noun}s") }
}

/// "Reading 4 files" live, "Read 4 files" once settled (`groupLabel`).
pub fn group_label(name: &str, count: usize, pending: bool) -> String {
    let noun = plural(verbs(name).map_or("call", |v| v[2]), count);
    format!("{} {count} {noun}", group_verb(name, pending))
}

/// The label a streaming call reads under before its arguments arrive.
pub fn streaming_label(name: &str) -> String {
    match verbs(name) {
        None => group_verb(name, true),
        Some(v) => {
            let article = if v[2].starts_with(|c: char| "aeiouAEIOU".contains(c)) { "an" } else { "a" };
            format!("{} {article} {}", group_verb(name, true), v[2])
        }
    }
}

/// An MCP call split into server and method, both readable (`mcpCall`).
#[derive(Clone, Debug, PartialEq)]
pub struct McpCall {
    pub server: Option<String>,
    pub label: String,
    /// The exact wire id, for the tooltip.
    pub detail: String,
}

pub fn mcp_call(name: &str, title: Option<&str>) -> McpCall {
    let mut server = None;
    let mut tool = name.to_owned();
    if let Some(rest) = name.strip_prefix("mcp__") {
        if let Some((head, tail)) = rest.split_once("__") {
            server = Some(head.to_owned());
            tool = tail.to_owned();
        }
    } else if let Some((head, tail)) = title.and_then(|t| t.split_once(" · ")) {
        server = Some(head.to_owned());
        tool = tail.to_owned();
    } else if let Some((s, m)) = qualified_name(name) {
        server = Some(s);
        tool = m;
    }
    let method = tool.rsplit('.').next().unwrap_or(&tool);
    McpCall {
        server: server.as_deref().map(humanize),
        label: humanize(method),
        detail: match &server {
            Some(s) => format!("{s} · {tool}"),
            None => tool.clone(),
        },
    }
}

/// `<server>__<method>` with no `mcp__`, the whole string and nothing else —
/// `/^([A-Za-z0-9][\w.-]*)__([\w.-]+)$/` in the web app.
fn qualified_name(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    let ident = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
    // Greedy like the regex: the server takes every `__` but the last.
    let (server, method) = raw.rsplit_once("__")?;
    let lead_ok = server.starts_with(|c: char| c.is_ascii_alphanumeric());
    (lead_ok && ident(server) && ident(method)).then(|| (server.to_owned(), method.to_owned()))
}

/// The same split, readable — what the row draws as two coloured halves.
pub fn named_parts(raw: &str) -> Option<(String, String)> {
    qualified_name(raw).map(|(s, m)| (humanize(&s), humanize(&m)))
}

/// `list_document_sessions` → `List Document Sessions`.
pub fn humanize(id: &str) -> String {
    let words: String = id.chars().map(|c| if c == '_' || c == '-' { ' ' } else { c }).collect();
    let words = words.split_whitespace().collect::<Vec<_>>().join(" ");
    if words.is_empty() {
        return id.to_owned();
    }
    let mut out = String::with_capacity(words.len());
    let mut boundary = true;
    for c in words.chars() {
        let word = c.is_alphanumeric() || c == '_';
        out.extend(if boundary && word { c.to_uppercase().collect::<Vec<_>>() } else { vec![c] });
        boundary = !word;
    }
    out
}

/// The absolute file a row acted on, for the tool types whose subject is one.
pub fn file_target(tool_type: ToolType, input: &Value) -> Option<String> {
    if !matches!(tool_type, ToolType::FileEdit | ToolType::FileRead) {
        return None;
    }
    path_field(input).filter(|p| p.starts_with('/')).map(str::to_owned)
}

/// The last two segments: enough to recognise a file beside the tool name.
pub fn shorten_path(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 2 { path.to_owned() } else { parts[parts.len() - 2..].join("/") }
}

pub fn basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

/// Tool input pretty-printed for the expanded body, minus what the header shows.
pub fn format_tool_input(input: &Value, omit: &[&str]) -> Option<String> {
    let Some(map) = object(input) else {
        return (!input.is_null()).then(|| serde_json::to_string_pretty(input).unwrap_or_default());
    };
    let rest: Map<String, Value> =
        map.iter().filter(|(k, _)| !omit.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    (!rest.is_empty()).then(|| serde_json::to_string_pretty(&Value::Object(rest)).unwrap_or_default())
}

/// The identifying argument when no `ToolType` is to hand — the permission card.
pub fn tool_argument(input: &Value) -> Option<String> {
    if let Some(p) = field(input, "pattern").filter(|p| !p.is_empty()) {
        return Some(p.to_owned());
    }
    if let Some(path) = path_field(input).filter(|p| !p.is_empty()) {
        return Some(shorten_path(path));
    }
    ["command", "query", "url", "skill"].iter().find_map(|k| field(input, k)).map(str::to_owned)
}

/// A failed call the reader never has to act on: the agent probing a path or a
/// binary. Measured as 38 of 45 failed `Bash` calls, so red on `is_error` alone
/// made red the transcript's resting state.
pub fn is_routine_error(text: Option<&str>) -> bool {
    let Some(text) = text else { return false };
    let lower = text.to_lowercase();
    lower.contains("is isolated in the worktree")
        || lower.contains("too complex to verify that it stays inside the worktree")
        || lower.contains("no such file or directory")
        || lower.contains("no matches found:")
        || lower.contains("command not found:")
        || text.lines().any(|l| l.starts_with("Blocked:"))
}

pub fn skill_brief(input: &Value) -> Option<String> {
    field(input, "args").map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

#[derive(Clone, Debug, PartialEq)]
pub struct SubagentBrief {
    pub task: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// fx's nested brief; `None` for every other harness.
pub fn subagent_brief(input: &Value) -> Option<SubagentBrief> {
    let request = nested(input, "request")?;
    let task = field(request, "task")?.trim();
    (!task.is_empty()).then(|| SubagentBrief {
        task: task.to_owned(),
        model: field(request, "model").map(str::to_owned),
        effort: field(request, "effort").map(str::to_owned),
    })
}

/// Both sides of an edit. `old` is `None` for a whole-file write.
#[derive(Clone, Debug, PartialEq)]
pub struct EditSides {
    pub path: String,
    pub old: Option<String>,
    pub new: String,
}

fn edit_pair(map: &Value) -> (String, String) {
    let get = |a: &str, b: &str| field(map, a).or_else(|| field(map, b)).unwrap_or("").to_owned();
    (get("old_string", "oldText"), get("new_string", "newText"))
}

/// `editSides`: an `Edit`, a `MultiEdit`'s list, or a `Write`'s whole content.
pub fn edit_sides(input: &Value) -> Option<EditSides> {
    let path = ["file_path", "path", "notebook_path"].iter().find_map(|k| field(input, k))?.to_owned();
    if let Some(edits) = object(input)?.get("edits").and_then(Value::as_array) {
        let pairs: Vec<_> =
            edits.iter().filter(|e| e.is_object()).map(edit_pair).filter(|(a, b)| !a.is_empty() || !b.is_empty()).collect();
        if pairs.is_empty() {
            return None;
        }
        let join = |side: fn(&(String, String)) -> &String| pairs.iter().map(side).cloned().collect::<Vec<_>>().join("\n");
        return Some(EditSides { path, old: Some(join(|p| &p.0)), new: join(|p| &p.1) });
    }
    let (old, new) = edit_pair(input);
    if !old.is_empty() || !new.is_empty() {
        return Some(EditSides { path, old: Some(old), new });
    }
    let content = field(input, "content").or_else(|| field(input, "new_source"))?;
    Some(EditSides { path, old: None, new: content.to_owned() })
}

/// A ranged read's slice, line numbers stripped (`readRange`).
#[derive(Clone, Debug, PartialEq)]
pub struct ReadRange {
    pub path: String,
    pub text: String,
    pub start_line: u64,
}

pub fn read_range(input: &Value, output: &str) -> Option<ReadRange> {
    let path = field(input, "file_path").or_else(|| field(input, "path"))?.to_owned();
    let map = object(input)?;
    let offset = map.get("offset").and_then(Value::as_u64);
    let limit = map.get("limit").and_then(Value::as_u64);
    if offset.is_none() && limit.is_none() {
        return None;
    }
    let text = strip_line_numbers(output);
    if text.trim().is_empty() {
        return None;
    }
    Some(ReadRange { path, text, start_line: offset.unwrap_or(1) })
}

/// `cat -n` output (`   12\tcode`) back to the code, but only where every
/// non-blank line carries a number — anything else is left as it came.
fn strip_line_numbers(output: &str) -> String {
    let numbered = |l: &str| {
        let t = l.trim_start();
        let digits = t.chars().take_while(char::is_ascii_digit).count();
        digits > 0 && t[digits..].starts_with('\t')
    };
    let meaningful: Vec<&str> = output.lines().filter(|l| !l.trim().is_empty()).collect();
    if meaningful.is_empty() || !meaningful.iter().all(|l| numbered(l)) {
        return output.to_owned();
    }
    output
        .lines()
        .map(|l| if numbered(l) { l.split_once('\t').map_or(l, |(_, rest)| rest) } else { l })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Changes {
    pub added: usize,
    pub removed: usize,
}

/// `+N -M` for two sides: lines outside their longest common subsequence.
/// Past ~4M cells it falls back to the line counts, which only over-counts.
pub fn count_changes(sides: &EditSides) -> Changes {
    let old: Vec<&str> = sides.old.as_deref().map_or(Vec::new(), |o| o.lines().collect());
    let new: Vec<&str> = sides.new.lines().collect();
    if old.len().saturating_mul(new.len()) > 4_000_000 {
        return Changes { added: new.len(), removed: old.len() };
    }
    let mut row = vec![0usize; new.len() + 1];
    for a in &old {
        let mut diag = 0;
        for (j, b) in new.iter().enumerate() {
            let up = row[j + 1];
            row[j + 1] = if a == b { diag + 1 } else { up.max(row[j]) };
            diag = up;
        }
    }
    let common = row[new.len()];
    Changes { added: new.len() - common, removed: old.len() - common }
}

/// The same for a harness that reports a unified diff (`countUnifiedChanges`).
pub fn count_unified_changes<'a>(diffs: impl IntoIterator<Item = &'a str>) -> Changes {
    let mut c = Changes::default();
    for diff in diffs {
        let mut in_hunk = false;
        for line in diff.lines() {
            if line.starts_with("@@") {
                in_hunk = true;
            } else if line.starts_with("diff --git ") {
                in_hunk = false;
            }
            if !in_hunk && (line.starts_with("+++") || line.starts_with("---")) {
                continue;
            }
            if line.starts_with('+') {
                c.added += 1;
            } else if line.starts_with('-') {
                c.removed += 1;
            }
        }
    }
    c
}

/// Cut at `max` characters with an ellipsis (`truncate` in lib/format).
pub fn truncate(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summary_prefers_pattern_over_path() {
        let input = json!({"pattern": "fn main", "path": "."});
        assert_eq!(tool_summary("Grep", ToolType::Search, &input).as_deref(), Some("fn main"));
    }

    #[test]
    fn summary_shortens_paths() {
        let input = json!({"file_path": "/Users/me/proj/src/app.ts"});
        assert_eq!(tool_summary("Read", ToolType::FileRead, &input).as_deref(), Some("src/app.ts"));
    }

    #[test]
    fn labels_take_the_tense() {
        assert_eq!(tool_label("Read", true), "Reading");
        assert_eq!(tool_label("Write", false), "Wrote");
        assert_eq!(tool_label("Bash", false), "Bash");
        assert_eq!(tool_label("mystery", false), "mystery");
    }

    #[test]
    fn group_labels_count() {
        assert_eq!(group_label("Read", 4, false), "Read 4 files");
        assert_eq!(group_label("Bash", 6, true), "Running 6 commands");
        assert_eq!(group_label("ls", 2, false), "Listed 2 directories");
        assert_eq!(group_label("ToolSearch", 1, false), "ToolSearch 1 call");
        assert_eq!(streaming_label("Write"), "Writing a file");
    }

    #[test]
    fn mcp_names_split() {
        let c = mcp_call("mcp__linear-server__save_issue", None);
        assert_eq!(c.server.as_deref(), Some("Linear Server"));
        assert_eq!(c.label, "Save Issue");
        assert_eq!(c.detail, "linear-server · save_issue");
        let codex =
            mcp_call("list_document_sessions", Some("codex_apps · codex_document_control.list_document_sessions"));
        assert_eq!(codex.label, "List Document Sessions");
        assert_eq!(codex.server.as_deref(), Some("Codex Apps"));
    }

    #[test]
    fn qualified_names_are_strict() {
        assert_eq!(named_parts("github__create_issue"), Some(("Github".into(), "Create Issue".into())));
        assert_eq!(named_parts("ls /tmp/a__b"), None);
        assert_eq!(named_parts("__x"), None);
    }

    #[test]
    fn routine_errors() {
        assert!(is_routine_error(Some("Exit code 1\nls: x: No such file or directory")));
        assert!(is_routine_error(Some("Blocked: outside the tree")));
        assert!(!is_routine_error(Some("panicked at src/main.rs")));
        assert!(!is_routine_error(None));
    }

    #[test]
    fn edit_sides_and_counts() {
        let sides = edit_sides(&json!({"file_path": "/a.rs", "old_string": "a\nb\nc", "new_string": "a\nB\nc\nd"})).unwrap();
        assert_eq!(count_changes(&sides), Changes { added: 2, removed: 1 });
        let write = edit_sides(&json!({"file_path": "/a.rs", "content": "x\ny"})).unwrap();
        assert_eq!(write.old, None);
        assert_eq!(count_changes(&write), Changes { added: 2, removed: 0 });
    }

    #[test]
    fn unified_counts_skip_headers() {
        let diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n+more";
        assert_eq!(count_unified_changes([diff]), Changes { added: 2, removed: 1 });
    }

    #[test]
    fn ranged_reads_strip_numbers() {
        let r = read_range(&json!({"file_path": "/a.rs", "offset": 10, "limit": 2}), "    10\tfn a() {\n    11\t}").unwrap();
        assert_eq!(r.text, "fn a() {\n}");
        assert_eq!(r.start_line, 10);
        assert_eq!(read_range(&json!({"file_path": "/a.rs"}), "x"), None);
    }

    #[test]
    fn input_body_omits_header_fields() {
        let body = format_tool_input(&json!({"command": "ls", "timeout": 5, "run_in_background": true}), &["command", "timeout"]);
        assert_eq!(body.as_deref(), Some("{\n  \"run_in_background\": true\n}"));
        assert_eq!(format_tool_input(&json!({"command": "ls"}), &["command"]), None);
    }
}
