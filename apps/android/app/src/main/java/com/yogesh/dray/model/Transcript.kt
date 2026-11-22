package com.yogesh.dray.model

import com.yogesh.dray.wire.AgentEvent
import com.yogesh.dray.wire.ImageRef
import com.yogesh.dray.wire.Payload
import com.yogesh.dray.wire.ToolResult
import com.yogesh.dray.wire.isCut
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/**
 * A session's events as held: deduped by id, since a subagent restarts `seq`. Compared by
 * identity, not content: every change makes a new one, and a deep compare per redraw is a long log's cost.
 */
class Transcript(
    val events: List<AgentEvent> = emptyList(),
    val ids: Set<String> = emptySet(),
    val olderBefore: Int? = null,
) {
    fun copy(events: List<AgentEvent> = this.events, ids: Set<String> = this.ids, olderBefore: Int? = this.olderBefore) =
        Transcript(events, ids, olderBefore)

    fun plus(e: AgentEvent): Transcript = if (e.id in ids) this else copy(events = events + e, ids = ids + e.id)

    companion object {
        fun of(events: List<AgentEvent>, olderBefore: Int?): Transcript {
            val seen = LinkedHashMap<String, AgentEvent>()
            for (e in events) seen.putIfAbsent(e.id, e)
            return Transcript(seen.values.toList(), seen.keys, olderBefore)
        }
    }
}

enum class ToolState { Pending, Done, Failed }

data class ToolCall(
    val id: String,
    val name: String,
    val toolType: String,
    val input: JsonElement,
    val title: String?,
    val output: String?,
    val state: ToolState,
    val images: List<ImageRef> = emptyList(),
    /** The harness's id for the call, which a subagent's events name it by. */
    val callId: String? = null,
    /** Its input or output was cut by the server; the store reads it whole. */
    val cut: Boolean = false,
) {
    /** What the row names beside its verb — the desktop's `toolSummary`. */
    val summary: String? get() = title ?: toolSummary(name, toolType, input)
}

/** One drawn line of a turn's work. */
sealed interface Item {
    val id: String

    /** `reaction`: the reader's emoji on it. */
    data class Text(override val id: String, val text: String, val reaction: String? = null) : Item
    data class Tool(val call: ToolCall) : Item { override val id get() = call.id }
    /** Consecutive calls to one tool, behind one row. */
    data class Group(override val id: String, val name: String, val calls: List<ToolCall>, val targets: Int, val target: String?) : Item
    /** A prompt typed into the running turn: the reader's own words, kept on screen through a collapse. */
    data class Prompt(override val id: String, val text: String, val from: String?, val images: List<ImageRef>) : Item
    data class Failure(override val id: String, val text: String) : Item

    /** Moves whenever the row grows: a group keeps its first call's id but gains calls. */
    val newestId: String get() = if (this is Group) calls.lastOrNull()?.id ?: id else id
}

data class TurnPrompt(val text: String, val from: String?, val images: List<ImageRef>)

/** A user prompt to the `turn_completed` that closes it. */
data class Turn(
    val id: String,
    val prompt: TurnPrompt? = null,
    val work: List<Item> = emptyList(),
    val completed: Boolean = false,
    /** The red row a failed turn closes on. */
    val failure: String? = null,
    /** The turn's last message, which a collapsed turn keeps on screen. */
    val finalText: String? = null,
    /** `finalText` was the last row of `work` and is dropped from it, so it draws in the same place folded or not. */
    val finalLifted: Boolean = false,
    /** The message `finalText` stands for, which a reaction names. */
    val finalMessage: Item.Text? = null,
) {
    val running: Boolean get() = !completed
    /** Rows a collapse would hide: queued prompts stay on screen. */
    val rows: Int get() = work.count { it !is Item.Prompt }

    /** Stretches between queued prompts, each folding on its own so a prompt stays where it was typed. */
    val segments: List<Segment>
        get() {
            val out = mutableListOf<Segment>()
            var items = mutableListOf<Item>()
            for (item in work) {
                if (item is Item.Prompt) {
                    out += Segment(items, item)
                    items = mutableListOf()
                } else items += item
            }
            out += Segment(items, null)
            return out
        }

    /** Every picture in the turn, in reading order: what the viewer pages through. */
    val gallery: List<Shot>
        get() {
            fun attached(images: List<ImageRef>) = images.map { Shot(it, "Attached", fileName(it)) }
            fun calls(calls: List<ToolCall>) = calls.flatMap { c -> c.images.map { Shot(it, toolLabel(c.name, false), c.summary) } }
            fun shown(text: String): List<Shot> {
                val blocks = markdownBlocks(text).mapNotNull { b ->
                    (b as? MdBlock.Image)?.let { val ref = ImageRef(url = it.url); Shot(ref, "Image", it.alt.ifEmpty { fileName(ref) }) }
                }
                val named = imagePaths(text).map { val ref = ImageRef(path = it); Shot(ref, "Image", fileName(ref)) }
                return blocks + named
            }
            val out = attached(prompt?.images.orEmpty()).toMutableList()
            for (item in work) when (item) {
                is Item.Tool -> out += calls(listOf(item.call))
                is Item.Group -> out += calls(item.calls)
                is Item.Prompt -> out += attached(item.images)
                is Item.Text -> out += shown(item.text)
                is Item.Failure -> {}
            }
            if (finalLifted && finalText != null) out += shown(finalText)
            // One page per picture: a tap finds it by ref, so a repeat would open on the first.
            val seen = mutableSetOf<ImageRef>()
            return out.filter { seen.add(it.ref) }
        }
}

data class Segment(val items: List<Item>, val prompt: Item.Prompt?)

/** One picture in a turn's gallery, and the line naming where it came from: "Read /tmp/hero.png". */
data class Shot(val ref: ImageRef, val verb: String, val target: String?)

private fun fileName(ref: ImageRef): String? {
    // A `data:` URL has no name, only bytes.
    val s = ref.path ?: ref.url ?: return null
    return if (s.startsWith("data:")) null else s.split('/').lastOrNull { it.isNotEmpty() }
}

/** The pictures tools handed back in a folded stretch, drawn under its summary line so a fold never hides them. */
fun foldedImages(items: List<Item>): List<ImageRef> = items.flatMap {
    when (it) {
        is Item.Tool -> it.call.images
        is Item.Group -> it.calls.flatMap { c -> c.images }
        else -> emptyList()
    }
}

fun plural(n: Int, word: String) = "$n $word${if (n == 1) "" else "s"}"

/** "3 tool calls · 1 message", the desktop's summary line. */
fun summaryLabel(items: List<Item>): String {
    var calls = 0
    var messages = 0
    for (item in items) when (item) {
        is Item.Tool -> calls++
        is Item.Group -> calls += item.calls.size
        is Item.Text -> messages++
        else -> {}
    }
    val parts = buildList {
        if (calls > 0) add(plural(calls, "tool call"))
        if (messages > 0) add(plural(messages, "message"))
    }
    return if (parts.isEmpty()) plural(items.size, "step") else parts.joinToString(" · ")
}

/**
 * The desktop's `buildTranscript`, cut down to what the phone draws: subagents' own events are
 * skipped, a call joins its result on `callId` and is pending only while the session is busy,
 * and runs of one tool group.
 */
fun buildTurns(events: List<AgentEvent>, busy: Boolean): List<Turn> {
    val main = events.filter { it.subagent == null || it.subagent == JsonNull }
    val results = HashMap<String, ToolResult>()
    for (e in main) (e.payload as? Payload.ToolCompleted)?.let { results[it.callId] = it.result }
    // A prompt abandons every call still open before it: no result is coming.
    val abandoned = HashSet<String>()
    val open = mutableListOf<String>()
    for (e in main) when (val p = e.payload) {
        is Payload.ToolStarted -> if (results[p.callId] == null) open += p.callId
        is Payload.UserMessage -> if (!p.queued) { abandoned += open; open.clear() }
        else -> {}
    }

    // The reader's reaction on each message, the newest where they changed it.
    val mine = HashMap<String, String>()
    for (e in main) (e.payload as? Payload.Reaction)?.takeIf { it.byUser }?.let { mine[it.messageId] = it.emoji }

    val turns = mutableListOf<Turn>()
    var current: Turn? = null
    val calls = mutableListOf<ToolCall>()

    fun append(item: Item) { current = current?.let { it.copy(work = it.work + item) } }

    fun flushCalls() {
        if (calls.isEmpty()) return
        if (calls.size >= 2) {
            val names = calls.map { it.summary ?: "\u0000${it.id}" }
            val distinct = names.toSet()
            val only = if (distinct.size == 1) calls[0].summary else null
            append(Item.Group("group-${calls[0].id}", calls[0].name, calls.toList(), distinct.size, only))
        } else {
            append(Item.Tool(calls[0]))
        }
        calls.clear()
    }

    fun close() {
        flushCalls()
        var turn = current ?: return
        current = null
        // The harness says a failure twice; the red row wins.
        val last = turn.work.lastOrNull()
        if (turn.failure != null && last is Item.Text && last.text.trim() == turn.failure!!.trim()) {
            turn = turn.copy(work = turn.work.dropLast(1))
        }
        val tail = turn.work.lastOrNull()
        if (turn.completed && tail is Item.Text) {
            turn = turn.copy(finalText = tail.text, finalLifted = true, finalMessage = tail, work = turn.work.dropLast(1))
        } else if (turn.completed) {
            // Cut short with a call after its last message: that message still ends the fold.
            (turn.work.lastOrNull { it is Item.Text } as Item.Text?)?.let { turn = turn.copy(finalText = it.text, finalMessage = it) }
        }
        turns += turn
    }

    fun ensureTurn(e: AgentEvent) { if (current == null) current = Turn("head-${e.id}") }

    for (e in main) {
        when (val p = e.payload) {
            is Payload.UserMessage -> {
                val shown = stripSender(p.text, p.fromTitle, p.fromId, p.fromBot != null)
                // Dray's own prompt draws no bubble: a kickoff, a review, a reaction told to the agent.
                if (p.kickoff && p.queued && current != null) continue
                if (p.queued && current != null) {
                    flushCalls()
                    append(Item.Prompt(e.id, shown, p.fromTitle, p.images))
                } else {
                    close()
                    current = Turn(e.id, if (p.kickoff) null else TurnPrompt(shown, p.fromTitle, p.images))
                }
            }
            is Payload.AssistantText -> if (p.text.isNotBlank()) {
                ensureTurn(e)
                flushCalls()
                append(Item.Text(e.id, p.text, mine[e.id]))
            }
            is Payload.ToolStarted -> {
                ensureTurn(e)
                val r = results[p.callId]
                val state = when {
                    r != null -> if (r.isError) ToolState.Failed else ToolState.Done
                    busy && p.callId !in abandoned -> ToolState.Pending
                    else -> ToolState.Done
                }
                val call = ToolCall(
                    e.id, p.name, p.toolType, p.input, p.title, r?.text, state, r?.images.orEmpty(), p.callId,
                    isCut(p.input) || r?.cut == true,
                )
                // A delegated run keeps its own row, and so does a call carrying a picture: a closed group would hide it.
                val alone = p.toolType == "subagent_spawn" || call.images.isNotEmpty()
                val last = calls.lastOrNull()
                if (last != null && (last.name != p.name || alone)) flushCalls()
                calls += call
                if (alone) flushCalls()
            }
            is Payload.Error -> {
                ensureTurn(e)
                flushCalls()
                append(Item.Failure(e.id, p.message))
            }
            is Payload.TurnCompleted -> {
                ensureTurn(e)
                var t = current!!.copy(completed = true)
                if (p.failed) {
                    // Empty as well as absent: a harness can send a failed turn's sentence as "".
                    val said = p.finalText?.trim().orEmpty()
                    t = t.copy(failure = said.ifEmpty { "Turn failed" })
                }
                current = t
                close()
            }
            else -> {}
        }
    }
    close()
    return turns
}

/**
 * A relayed prompt opens with a line for the receiving agent; the bubble names the sender
 * instead. Rebuilt as `relay.ts` does up to the sender's id, then read to the line's end.
 */
fun stripSender(text: String, title: String?, id: String?, bot: Boolean = false): String {
    if (title == null || id == null) return text
    val who = "the Dray ${if (bot) "bot" else "session"} \"$title\" ($id)"
    for (opening in listOf("[message from $who", "[reply from $who")) {
        if (!text.startsWith(opening)) continue
        val rest = text.substring(opening.length)
        val known = listOf("]\n\n", " on ", "; ", " to your question").any { rest.startsWith(it) }
        val end = rest.indexOf("]\n\n")
        if (!known || end < 0) return text
        return rest.substring(end + 3)
    }
    return text
}
