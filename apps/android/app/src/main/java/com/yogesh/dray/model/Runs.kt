package com.yogesh.dray.model

import com.yogesh.dray.wire.AgentEvent
import com.yogesh.dray.wire.Payload
import com.yogesh.dray.wire.ToolResult
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.isCut
import com.yogesh.dray.wire.str
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

// Runs.swift's model half: a session's subagents and backgrounded shells, off its loaded events.

/** One subagent or backgrounded shell: the desktop's `SubagentRun`. `id` is the spawning call's, which the events' `subagent` envelope carries. */
data class AgentRun(
    val id: String,
    val session: SessionKey,
    /** The harness's handle, what `stop_task` names; null until a lifecycle event carries it. */
    val taskId: String? = null,
    val label: String? = null,
    val description: String? = null,
    /** The newest `subagent_progress` line. */
    val status: String? = null,
    val done: Boolean = false,
    val lastAt: String? = null,
    /** The run's own work, its lifecycle events left out. */
    val events: List<AgentEvent> = emptyList(),
    /** The spawning call: a shell's command, an agent's brief. */
    val tool: String? = null,
    val input: JsonElement = JsonNull,
    /** The spawning call's answer; a backgrounded shell's names the file its output goes to. */
    val answer: String? = null,
    /** The spawning call was cut by the server: its brief or answer is a prefix until read whole. */
    val cut: Boolean = false,
    val harness: String? = null,
    /** Read off the log or the live task list alone, with no events here to open onto. */
    val logOnly: Boolean = false,
) {
    /** Claude Code's `Bash` and `Monitor` register as `local_bash`; grok's task list says `bash`. */
    val shell: Boolean get() = tool == "Bash" || tool == "Monitor" || label == "local_bash" || label == "bash"
    val title: String get() = description ?: label ?: if (shell) "Background task" else "Subagent"
    val handle: String get() = taskId ?: id
    val command: String? get() = input["command"].str
    /** fx nests its brief: `request.task`, or since 0.0.17 a message to a named child. */
    val brief: String? get() = input["request"]["task"].str ?: (if (fxAgent != null) input["message"].str else null) ?: input["prompt"].str
    /** The child fx 0.0.17 names, which `fx_subagent_events` reads back. */
    val fxAgent: String? get() = if (input["action"].str == "message") input["agent"].str else null
    /** Opens as a chat of its own: a shell expands in place, and an older fx's run names no child to read. */
    val chat: Boolean get() = !shell && !logOnly && (harness != "fx" || fxAgent != null)
    /** fx saves a child's conversation only when its turn ends, so its chat waits for that. */
    val locked: Boolean get() = harness == "fx" && !done
    /** What tapping does anything for: a chat to open, or something to expand. */
    val opens: Boolean get() = if (chat) !locked else command != null || events.isNotEmpty() || brief != null

    /** Calls a `lite` read cut that this run draws as text: its spawning call, and a Claude subagent's handback. */
    val cutCalls: List<String>
        get() {
            val handbacks = events.mapNotNull { e ->
                val p = e.payload as? Payload.ToolStarted ?: return@mapNotNull null
                if (p.name == "SubagentHandback" && isCut(p.input)) p.callId else null
            }
            return (if (cut) listOf(id) else emptyList()) + handbacks
        }
}

/**
 * A session's runs, newest first: the desktop's `buildTranscript` pass over subagent envelopes.
 * `live` is the tasks its child still holds; a run outside it is over whether or not it said so,
 * since only a live child sends the completion.
 */
fun buildRuns(events: List<AgentEvent>, session: SessionKey, live: Set<String>, busy: Boolean): List<AgentRun> {
    val calls = HashMap<String, Pair<String, JsonElement>>()
    val answers = HashMap<String, String>()
    val cut = HashSet<String>()
    val abandoned = HashSet<String>()
    val open = mutableListOf<String>()
    // Every call, a subagent's too: a shell it backgrounds is a run of the session's own.
    for (e in events) when (val p = e.payload) {
        is Payload.ToolStarted -> {
            calls[p.callId] = p.name to p.input
            if (e.mainThread) open += p.callId
        }
        is Payload.ToolCompleted -> {
            answers[p.callId] = p.result.text
            if (p.result.cut) cut += p.callId
        }
        // A prompt abandons every call still open before it, as `buildTurns` reads it.
        is Payload.UserMessage -> if (!p.queued && e.mainThread) { abandoned += open; open.clear() }
        else -> {}
    }
    val order = mutableListOf<String>()
    val runs = HashMap<String, AgentRun>()
    for (e in events) {
        val id = e.subagent["id"].str ?: continue
        var run = runs[id] ?: AgentRun(id, session).also { order += id }
        // The completion's envelope carries no label, so the first one sticks.
        run = run.copy(label = run.label ?: e.subagent["label"].str, harness = run.harness ?: e.harness, lastAt = e.ts ?: run.lastAt)
        run = when (val p = e.payload) {
            is Payload.SubagentStarted -> run.copy(taskId = p.agentId.ifEmpty { null }, label = run.label ?: p.label, description = p.description)
            is Payload.SubagentProgress -> run.copy(taskId = p.agentId.ifEmpty { null }, status = p.description)
            is Payload.SubagentCompleted -> run.copy(taskId = p.agentId.ifEmpty { null }, done = true)
            else -> run.copy(events = run.events + e)
        }
        runs[id] = run
    }
    return order.reversed().mapNotNull { id ->
        var run = runs[id] ?: return@mapNotNull null
        calls[id]?.let { (name, input) -> run = run.copy(tool = name, input = input) }
        run = run.copy(answer = answers[id])
        run = run.copy(cut = isCut(run.input) || id in cut)
        if (!run.done && run.handle !in live) run = run.copy(done = answers[id] != null || id in abandoned || !busy)
        run
    }
}

/** A subagent's work as the chat's rows, its calls joined to their results. */
fun runItems(events: List<AgentEvent>, done: Boolean): List<Item> {
    val results = HashMap<String, ToolResult>()
    for (e in events) (e.payload as? Payload.ToolCompleted)?.let { results[it.callId] = it.result }
    return events.mapNotNull { e ->
        when (val p = e.payload) {
            is Payload.AssistantText -> if (p.text.isBlank()) null else Item.Text(e.id, p.text)
            // Claude Code logs the brief as the child's first message.
            is Payload.UserMessage -> Item.Prompt(e.id, p.text, null, p.images)
            // A Claude subagent answers through this call; drawn as a tool row it hid the answer.
            is Payload.ToolStarted -> if (p.name == "SubagentHandback") p.input["message"].str?.let { Item.Text(e.id, it) } else {
                val r = results[p.callId]
                Item.Tool(ToolCall(
                    id = e.id, name = p.name, toolType = p.toolType, input = p.input, title = p.title, output = r?.text,
                    state = r?.let { if (it.isError) ToolState.Failed else ToolState.Done } ?: if (done) ToolState.Done else ToolState.Pending,
                    images = r?.images.orEmpty(), callId = p.callId, cut = isCut(p.input) || r?.cut == true,
                ))
            }
            else -> null
        }
    }
}

private val AgentEvent.mainThread: Boolean get() = subagent == null || subagent == JsonNull

/** A backgrounded shell's output file, which its spawning call's answer names. */
fun outputPath(answer: String?): String? = answer?.let { Regex("""/\S+\.output""").find(it)?.value }
