import Foundation

// How a tool row reads, ported from the desktop's `tools.ts`. Keep the two
// in step: one act should read the same on either screen.

private func field(_ input: JSON, _ key: String) -> String? {
    guard let s = input[key]?.string, !s.isEmpty else { return nil }
    return s
}

/// The path a call carries, whatever its harness calls it.
private func pathField(_ input: JSON) -> String? {
    field(input, "file_path") ?? field(input, "path") ?? field(input, "notebook_path")
        ?? field(input, "target_file") ?? field(input, "target_directory")
}

/// The last two segments: enough to recognise a file beside the verb.
func shortenPath(_ path: String) -> String {
    let parts = path.split(separator: "/")
    return parts.count <= 2 ? path : parts.suffix(2).joined(separator: "/")
}

/// The interesting argument, drawn beside the verb.
func toolSummary(_ name: String, _ toolType: String, _ input: JSON) -> String? {
    if name == "Skill" { return field(input, "skill") }
    if name == "skill" { return field(input, "location")?.split(separator: "/").last.map(String.init) }
    if name == "use_tool" { return field(input, "tool_name") }
    // A search scopes itself with a directory; its subject is the pattern.
    if let pattern = field(input, "pattern") { return pattern }
    if let path = pathField(input) { return shortenPath(path) }
    if let request = input["request"], case .object = request {
        return field(request, "task") ?? field(request, "query")
    }
    switch toolType {
    case "shell": return field(input, "command")
    case "search": return field(input, "query")
    case "web": return field(input, "url") ?? field(input, "query")
    case "subagent_spawn": return field(input, "description") ?? field(input, "subagent_type")
    default:
        return field(input, "description") ?? field(input, "command") ?? field(input, "query") ?? field(input, "prompt")
    }
}

/// Running, done, and the noun a group counts.
private let verbs: [String: (String, String, String)] = {
    var v: [String: (String, String, String)] = [:]
    func set(_ names: [String], _ running: String, _ done: String, _ noun: String) {
        for n in names { v[n] = (running, done, noun) }
    }
    set(["Read", "read", "read_file"], "Reading", "Read", "file")
    set(["NotebookRead"], "Reading", "Read", "notebook")
    set(["Edit", "edit", "edit_file", "apply_patch", "search_replace"], "Editing", "Edited", "file")
    set(["NotebookEdit"], "Editing", "Edited", "notebook")
    set(["Write", "write", "write_file"], "Writing", "Wrote", "file")
    set(["Bash", "shell", "bash", "run_terminal_command"], "Bash", "Bash", "command")
    set(["powershell"], "PowerShell", "PowerShell", "command")
    set(["BashOutput", "get_command_or_subagent_output"], "Reading output", "Read output", "output")
    set(["read_tool_result"], "Reading output", "Read output", "result")
    set(["KillShell"], "Killing shell", "Killed shell", "shell")
    set(["Grep", "Glob", "grep", "find", "glob_files", "grep_files"], "Searching", "Searched", "pattern")
    set(["WebFetch", "web_fetch"], "Fetching", "Fetched", "page")
    set(["WebSearch", "web_search", "search"], "Searching web", "Searched web", "query")
    set(["AskUserQuestion", "ask_user_question"], "Asking", "Asked", "question")
    set(["Skill", "skill"], "Reading Skill", "Read Skill", "skill")
    set(["view_image"], "Viewing", "Viewed", "image")
    set(["ls", "list_dir"], "Listing", "Listed", "directory")
    set(["subagent", "spawn_subagent"], "Delegating", "Delegated", "task")
    set(["capability_search"], "Searching", "Searched", "capability")
    set(["todo_write", "TodoWrite"], "Todo", "Todo", "todo list")
    set(["kill_command_or_subagent"], "Stopping", "Stopped", "task")
    set(["monitor"], "Watching", "Watched", "command")
    set(["search_tool"], "Finding tool", "Found tool", "tool")
    set(["use_tool"], "Running", "Ran", "tool")
    set(["workflow"], "Running workflow", "Ran workflow", "workflow")
    set(["enter_plan_mode"], "Entering plan mode", "Entered plan mode", "plan")
    set(["exit_plan_mode"], "Presenting plan", "Presented plan", "plan")
    return v
}()

/// A group's verb where the row's would read wrong with a count after it.
private let groupVerbs: [String: (String, String)] = [
    "Bash": ("Running", "Ran"), "shell": ("Running", "Ran"), "bash": ("Running", "Ran"),
    "run_terminal_command": ("Running", "Ran"),
    "BashOutput": ("Reading", "Read"), "KillShell": ("Killing", "Killed"),
    "WebSearch": ("Searching", "Searched"), "web_search": ("Searching", "Searched"),
    "Skill": ("Reading", "Read"), "skill": ("Reading", "Read"), "read_tool_result": ("Reading", "Read"),
]

/// "Reading" live, "Read" once settled. An MCP tool reads "MCP", as a shell reads "Bash".
func toolLabel(_ name: String, pending: Bool) -> String {
    if name.hasPrefix("mcp__") { return "MCP" }
    guard let v = verbs[name] else { return name }
    return pending ? v.0 : v.1
}

func groupVerb(_ name: String, pending: Bool) -> String {
    if let v = groupVerbs[name] { return pending ? v.0 : v.1 }
    return toolLabel(name, pending: pending)
}

/// "Read 3 files"; a tool with no noun counts calls.
func groupLabel(_ name: String, count: Int, pending: Bool) -> String {
    var noun = verbs[name]?.2 ?? "call"
    if count != 1 {
        noun = noun.range(of: "[^aeiou]y$", options: .regularExpression) != nil
            ? noun.dropLast() + "ies" : noun + "s"
    }
    return "\(groupVerb(name, pending: pending)) \(count) \(noun)"
}

/// An MCP call's method, readable: `mcp__linear__save_issue` → "Linear · Save Issue".
func mcpSummary(_ name: String) -> String? {
    let parts = name.components(separatedBy: "__")
    guard parts.count >= 3 else { return nil }
    let human = { (s: String) in s.replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression).capitalized }
    return "\(human(parts[1])) · \(human(parts.dropFirst(2).joined(separator: "__")))"
}

/// `+N -M` for a call that edits a file, from its own arguments. A line
/// diff over the replaced fragment, as the desktop counts it.
func editCounts(_ call: ToolCall) -> (added: Int, removed: Int)? {
    guard call.toolType == "file_edit" else { return nil }
    let input = call.input
    let pairs: [(String, String)]
    if case .array(let edits)? = input["edits"] {
        pairs = edits.map { ($0["old_string"]?.string ?? "", $0["new_string"]?.string ?? "") }
    } else if input["old_string"] != nil || input["new_string"] != nil {
        pairs = [(input["old_string"]?.string ?? "", input["new_string"]?.string ?? "")]
    } else if let content = input["content"]?.string ?? input["new_source"]?.string {
        pairs = [("", content)]
    } else {
        return nil
    }
    var added = 0, removed = 0
    for (old, new) in pairs {
        let lines = { (s: String) in s.isEmpty ? [] : s.components(separatedBy: "\n") }
        for change in lines(new).difference(from: lines(old)) {
            if case .insert = change { added += 1 } else { removed += 1 }
        }
    }
    return added + removed > 0 ? (added, removed) : nil
}

/// An error the agent recovers from on its own — a guessed path, a missing
/// binary — so the row reports it without the red.
func isRoutineError(_ text: String?) -> Bool {
    guard let text else { return false }
    let patterns = [
        "is isolated in the worktree|too complex to verify that it stays inside the worktree",
        "no such file or directory", "no matches found:", "command not found:",
    ]
    if patterns.contains(where: { text.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil }) {
        return true
    }
    return text.split(separator: "\n").contains { $0.hasPrefix("Blocked:") }
}

/// A whole-file read is the agent pulling a file into context, not showing
/// it: its output is the file, so the row has nothing to open.
func isWholeFileRead(_ call: ToolCall) -> Bool {
    call.toolType == "file_read" && call.input["offset"] == nil && call.input["limit"] == nil
}

/// The identifying argument of a call whose tool type isn't to hand — the
/// permission card sees raw wire input and no type.
func toolArgument(_ input: JSON) -> String? {
    pathField(input).map(shortenPath) ?? field(input, "command") ?? field(input, "pattern")
        ?? field(input, "query") ?? field(input, "url") ?? field(input, "skill")
}
