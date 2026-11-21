package com.yogesh.dray.model

import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// How a tool row reads, ported from the desktop's `tools.ts` by way of the iOS app's
// Tools.swift. Keep the three in step: one act should read the same on every screen.

private fun field(input: JsonElement?, key: String): String? = input[key].str?.takeIf { it.isNotEmpty() }

/** The path a call carries, whatever its harness calls it. */
private fun pathField(input: JsonElement?): String? =
    field(input, "file_path") ?: field(input, "path") ?: field(input, "notebook_path")
        ?: field(input, "target_file") ?: field(input, "target_directory")

/** The last two segments: enough to recognise a file beside the verb. */
fun shortenPath(path: String): String {
    val parts = path.split('/').filter { it.isNotEmpty() }
    return if (parts.size <= 2) path else parts.takeLast(2).joinToString("/")
}

/** The interesting argument, drawn beside the verb. */
fun toolSummary(name: String, toolType: String, input: JsonElement?): String? {
    if (name == "Skill") return field(input, "skill")
    if (name == "skill") return field(input, "location")?.split('/')?.lastOrNull { it.isNotEmpty() }
    if (name == "use_tool") return field(input, "tool_name")
    // A search scopes itself with a directory; its subject is the pattern.
    field(input, "pattern")?.let { return it }
    pathField(input)?.let { return shortenPath(it) }
    val request = input["request"]
    if (request is JsonObject) return field(request, "task") ?: field(request, "query")
    return when (toolType) {
        "shell" -> field(input, "command")
        "search" -> field(input, "query")
        "web" -> field(input, "url") ?: field(input, "query")
        "subagent_spawn" -> field(input, "description") ?: field(input, "subagent_type")
        else -> field(input, "description") ?: field(input, "command") ?: field(input, "query") ?: field(input, "prompt")
    }
}

private data class Verb(val running: String, val done: String, val noun: String)

private val verbs: Map<String, Verb> = buildMap {
    fun set(names: List<String>, running: String, done: String, noun: String) = names.forEach { put(it, Verb(running, done, noun)) }
    set(listOf("Read", "read", "read_file"), "Reading", "Read", "file")
    set(listOf("NotebookRead"), "Reading", "Read", "notebook")
    set(listOf("Edit", "edit", "edit_file", "apply_patch", "search_replace"), "Editing", "Edited", "file")
    set(listOf("NotebookEdit"), "Editing", "Edited", "notebook")
    set(listOf("Write", "write", "write_file"), "Writing", "Wrote", "file")
    set(listOf("Bash", "shell", "bash", "run_terminal_command"), "Bash", "Bash", "command")
    set(listOf("powershell"), "PowerShell", "PowerShell", "command")
    set(listOf("BashOutput", "get_command_or_subagent_output"), "Reading output", "Read output", "output")
    set(listOf("read_tool_result"), "Reading output", "Read output", "result")
    set(listOf("KillShell"), "Killing shell", "Killed shell", "shell")
    set(listOf("Grep", "Glob", "grep", "find", "glob_files", "grep_files"), "Searching", "Searched", "pattern")
    set(listOf("WebFetch", "web_fetch"), "Fetching", "Fetched", "page")
    set(listOf("WebSearch", "web_search", "search"), "Searching web", "Searched web", "query")
    set(listOf("AskUserQuestion", "ask_user_question"), "Asking", "Asked", "question")
    set(listOf("Skill", "skill"), "Reading Skill", "Read Skill", "skill")
    set(listOf("view_image"), "Viewing", "Viewed", "image")
    set(listOf("ls", "list_dir"), "Listing", "Listed", "directory")
    set(listOf("subagent", "spawn_subagent"), "Delegating", "Delegated", "task")
    set(listOf("capability_search"), "Searching", "Searched", "capability")
    set(listOf("todo_write", "TodoWrite"), "Todo", "Todo", "todo list")
    set(listOf("kill_command_or_subagent"), "Stopping", "Stopped", "task")
    set(listOf("monitor"), "Watching", "Watched", "command")
    set(listOf("search_tool"), "Finding tool", "Found tool", "tool")
    set(listOf("use_tool"), "Running", "Ran", "tool")
    set(listOf("workflow"), "Running workflow", "Ran workflow", "workflow")
    set(listOf("scheduler_create"), "Scheduling", "Scheduled", "task")
    set(listOf("scheduler_list"), "Reading schedule", "Read schedule", "schedule")
    set(listOf("scheduler_delete"), "Unscheduling", "Unscheduled", "task")
    set(listOf("enter_plan_mode"), "Entering plan mode", "Entered plan mode", "plan")
    set(listOf("exit_plan_mode"), "Presenting plan", "Presented plan", "plan")
}

/** A group's verb where the row's would read wrong with a count after it. */
private val groupVerbs: Map<String, Pair<String, String>> = mapOf(
    "Bash" to ("Running" to "Ran"), "shell" to ("Running" to "Ran"), "bash" to ("Running" to "Ran"),
    "run_terminal_command" to ("Running" to "Ran"),
    "BashOutput" to ("Reading" to "Read"), "KillShell" to ("Killing" to "Killed"),
    "WebSearch" to ("Searching" to "Searched"), "web_search" to ("Searching" to "Searched"),
    "Skill" to ("Reading" to "Read"), "skill" to ("Reading" to "Read"), "read_tool_result" to ("Reading" to "Read"),
    "TodoWrite" to ("Updating" to "Updated"), "todo_write" to ("Updating" to "Updated"),
)

/** "Reading" live, "Read" once settled. An MCP tool reads "MCP", as a shell reads "Bash". */
fun toolLabel(name: String, pending: Boolean): String {
    if (name.startsWith("mcp__")) return "MCP"
    val v = verbs[name] ?: return name
    return if (pending) v.running else v.done
}

fun groupVerb(name: String, pending: Boolean): String =
    groupVerbs[name]?.let { if (pending) it.first else it.second } ?: toolLabel(name, pending)

/** "Read 3 files"; a tool with no noun counts calls. */
fun groupLabel(name: String, count: Int, pending: Boolean): String {
    var noun = verbs[name]?.noun ?: "call"
    if (count != 1) noun = if (Regex("[^aeiou]y$").containsMatchIn(noun)) noun.dropLast(1) + "ies" else noun + "s"
    return "${groupVerb(name, pending)} $count $noun"
}

/** An MCP call's method, readable: `mcp__linear__save_issue` → "Linear · Save Issue". */
fun mcpSummary(name: String): String? {
    val parts = name.split("__")
    if (parts.size < 3) return null
    fun human(s: String) = s.replace(Regex("[_-]+"), " ").split(' ')
        .joinToString(" ") { w -> w.lowercase().replaceFirstChar { it.uppercase() } }
    return "${human(parts[1])} · ${human(parts.drop(2).joinToString("__"))}"
}

/** `+N -M` for a call that edits a file, from its own arguments: a line diff over the replaced fragment. */
fun editCounts(call: ToolCall): Pair<Int, Int>? {
    // Counted off fragments, a figure would be wrong; the row asks for the call instead.
    if (call.toolType != "file_edit" || com.yogesh.dray.wire.isCut(call.input)) return null
    val input = call.input
    val edits = input["edits"]
    val pairs: List<Pair<String, String>> = when {
        edits is JsonArray -> edits.map { (it["old_string"].str ?: "") to (it["new_string"].str ?: "") }
        input["old_string"] != null || input["new_string"] != null -> listOf((input["old_string"].str ?: "") to (input["new_string"].str ?: ""))
        else -> (input["content"].str ?: input["new_source"].str)?.let { listOf("" to it) } ?: return null
    }
    var added = 0
    var removed = 0
    for ((old, new) in pairs) {
        val a = if (old.isEmpty()) emptyList() else old.split("\n")
        val b = if (new.isEmpty()) emptyList() else new.split("\n")
        val common = lcs(a, b)
        added += b.size - common
        removed += a.size - common
    }
    return if (added + removed > 0) added to removed else null
}

/** The longest common subsequence's length, which is what a line diff's insertions and removals are counted off. */
private fun lcs(a: List<String>, b: List<String>): Int {
    if (a.isEmpty() || b.isEmpty()) return 0
    var prev = IntArray(b.size + 1)
    var cur = IntArray(b.size + 1)
    for (i in a.indices) {
        for (j in b.indices) cur[j + 1] = if (a[i] == b[j]) prev[j] + 1 else maxOf(prev[j + 1], cur[j])
        val t = prev; prev = cur; cur = t
    }
    return prev[b.size]
}

private val routine = listOf(
    "is isolated in the worktree|too complex to verify that it stays inside the worktree",
    "no such file or directory", "no matches found:", "command not found:",
).map { Regex(it, RegexOption.IGNORE_CASE) }

/** An error the agent recovers from on its own — a guessed path, a missing binary — so the row reports it without the red. */
fun isRoutineError(text: String?): Boolean {
    if (text == null) return false
    if (routine.any { it.containsMatchIn(text) }) return true
    return text.split("\n").any { it.startsWith("Blocked:") }
}

/** A whole-file read pulls a file into context rather than showing it: its output is the file, so the row has nothing to open. */
fun isWholeFileRead(call: ToolCall): Boolean =
    call.toolType == "file_read" && call.input["offset"] == null && call.input["limit"] == null

/** The identifying argument of a call whose tool type isn't to hand — the permission card sees raw input and no type. */
fun toolArgument(input: JsonElement?): String? =
    pathField(input)?.let(::shortenPath) ?: field(input, "command") ?: field(input, "pattern")
        ?: field(input, "query") ?: field(input, "url") ?: field(input, "skill")
