package com.yogesh.dray.model

import com.yogesh.dray.wire.AgentEvent
import com.yogesh.dray.wire.ImageRef
import com.yogesh.dray.wire.IssueCard
import com.yogesh.dray.wire.Lesson
import com.yogesh.dray.wire.MergeCard
import com.yogesh.dray.wire.Payload
import com.yogesh.dray.wire.PrMark
import com.yogesh.dray.wire.SecretAnswer
import com.yogesh.dray.wire.arr
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.str
import kotlinx.serialization.json.JsonElement
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

// BotTranscript.swift, restated: the desktop's `botItems` in `botTranscript.ts`. Keep the three in step.

/** Not a subagent's own event: the wire sends `subagent: null` on the main thread's, which decodes as `JsonNull`. */
private val AgentEvent.isMain: Boolean get() = subagent == null || subagent is kotlinx.serialization.json.JsonNull

/** One thing a bot's chat draws: the conversation, not the work. */
sealed interface BotItem {
    val id: String
    val ts: String?

    /** `reaction`: the bot's emoji on it, the newest where it reacted twice. */
    data class User(override val id: String, val text: String, val images: List<ImageRef>, val reaction: String?, override val ts: String?) : BotItem
    /** `reaction`: the reader's emoji on it. */
    data class Assistant(override val id: String, val text: String, override val ts: String?, val reaction: String? = null, val sessionId: String? = null) : BotItem
    /** A failed turn's sentence, or an error the harness raised. */
    data class Notice(override val id: String, val text: String, override val ts: String?) : BotItem
    data class Card(override val id: String, val card: MergeCard, override val ts: String?) : BotItem
    /** `started`: the card's issues the reader already handed to the agent. */
    data class Issues(override val id: String, val sessionId: String, val card: IssueCard, val started: Set<Int>, override val ts: String?) : BotItem
    /** "Started a new task", from the server's `task_started`, or in an older log a `dray session new` and the id it printed. */
    data class Task(override val id: String, val sessionId: String, val title: String?, override val ts: String?) : BotItem
    /** "Messaged", from a `dray session send`; consecutive ones fold into one row. */
    data class Sent(override val id: String, val target: String, override val ts: String?) : BotItem
    /** A message another bot sent this one. */
    data class BotMessage(override val id: String, val botId: String, val title: String, val text: String, override val ts: String?) : BotItem
    /** "Messaged" another bot, by the id `dray bot send` printed where it did. */
    data class BotSent(override val id: String, val name: String, val botId: String?, override val ts: String?) : BotItem
    data class Learned(override val id: String, val lesson: Lesson, val commit: String, val undone: Boolean, override val ts: String?) : BotItem
    /** A closed secret card: "Sent GH_TOKEN to <task>", "Saved…", "Declined…". Never the value. */
    data class Secret(override val id: String, val answer: SecretAnswer, override val ts: String?) : BotItem
}

/** A drawn row: an item, or a run of sends folded into one "Messaged" line. */
sealed interface BotRow {
    val id: String
    val ts: String?

    data class One(val item: BotItem) : BotRow {
        override val id get() = item.id
        override val ts get() = item.ts
    }
    data class Talk(override val id: String, val targets: List<String>, override val ts: String?) : BotRow
}

/** The chat's items from one session's events. Task reports carry no row: the bot's reply already says what they held. */
fun botItems(events: List<AgentEvent>): List<BotItem> {
    val main = events.filter { it.isMain }
    val undone = mutableSetOf<String>()
    // Read whole first, since a reaction lands after its message; the newest wins.
    val reactions = mutableMapOf<String, String>()
    val mine = mutableMapOf<String, String>()
    // Tasks the server logged; a bot's call is read only for an id none names, as a log from before that event holds.
    val announced = mutableSetOf<String>()
    val started = mutableMapOf<String, MutableSet<Int>>()
    for (e in main) when (val p = e.payload) {
        is Payload.LearnedUndone -> undone += "${p.commit}\u0000${p.path}"
        is Payload.Reaction -> if (p.byUser) mine[p.messageId] = p.emoji else reactions[p.messageId] = p.emoji
        is Payload.TaskStarted -> announced += p.taskId.lowercase()
        is Payload.IssueApproved -> started.getOrPut(p.cardId) { mutableSetOf() } += p.number
        else -> {}
    }

    val items = mutableListOf<BotItem>()
    val starts = mutableSetOf<String>()
    val sends = mutableMapOf<String, List<SentTo>>()
    var review = false
    for (e in main) {
        when (val p = e.payload) {
            is Payload.UserMessage -> {
                review = p.kickoff && p.text.startsWith("Review:")
                when {
                    p.fromBot != null -> items += BotItem.BotMessage(
                        e.id, p.fromBot, p.fromTitle ?: "", stripSender(p.text, p.fromTitle, p.fromId, bot = true), e.ts,
                    )
                    p.fromId != null -> {}
                    !p.kickoff -> items += BotItem.User(e.id, p.text, p.images, reactions[e.id], e.ts)
                }
            }
            is Payload.AssistantText -> if (p.text.isNotBlank() && !review) items += BotItem.Assistant(e.id, p.text, e.ts, mine[e.id], e.sessionId)
            is Payload.Error -> items += BotItem.Notice(e.id, p.message, e.ts)
            is Payload.MergeCardPosted -> items += BotItem.Card(e.id, p.card, e.ts)
            is Payload.IssueCardPosted -> items += BotItem.Issues(e.id, e.sessionId, p.card, started[e.id].orEmpty(), e.ts)
            is Payload.TaskStarted -> items += BotItem.Task(e.id, p.taskId.lowercase(), p.title, e.ts)
            is Payload.SecretAnswered -> if (p.answer.draws) items += BotItem.Secret(e.id, p.answer, e.ts)
            is Payload.Learned -> for (f in p.files) {
                items += BotItem.Learned("${e.id}:${f.path}", f, p.commit, "${p.commit}\u0000${f.path}" in undone, e.ts)
            }
            is Payload.TurnCompleted -> if (p.failed) {
                val said = p.finalText?.trim().orEmpty()
                // The harness says a failure twice; the red row wins.
                val last = items.lastOrNull()
                if (said.isNotEmpty() && last is BotItem.Assistant && last.text.trim() == said) items.removeAt(items.lastIndex)
                items += BotItem.Notice(e.id, said.ifEmpty { "Turn failed" }, e.ts)
            }
            is Payload.ToolStarted -> {
                val cmd = command(p.input) ?: continue
                val plain = unquoted(cmd)
                if (startsSession.containsMatchIn(plain)) starts += p.callId
                val s = sentMessages(cmd, plain)
                if (s.isNotEmpty()) sends[p.callId] = s
            }
            is Payload.ToolCompleted -> {
                if (p.result.isError) continue
                if (p.callId in starts) taskIdLine.find(p.result.text)?.let { m ->
                    val id = m.groupValues[1].lowercase()
                    if (id !in announced) items += BotItem.Task(p.callId, id, null, e.ts)
                }
                val botIds = botSentLine.findAll(p.result.text).map { it.groupValues[1].lowercase() }.toMutableList()
                sends[p.callId].orEmpty().forEachIndexed { i, s ->
                    val key = "${p.callId}:$i"
                    items += if (s.bot) BotItem.BotSent(key, s.target, botIds.removeFirstOrNull(), e.ts)
                    else BotItem.Sent(key, s.target, e.ts)
                }
            }
            else -> {}
        }
    }
    return items
}

/** Folds each run of task sends with nothing between into one "Messaged" row. */
fun botRows(items: List<BotItem>): List<BotRow> {
    val out = mutableListOf<BotRow>()
    for (item in items) {
        val last = out.lastOrNull()
        if (item is BotItem.Sent) {
            if (last is BotRow.Talk) out[out.lastIndex] = last.copy(targets = last.targets + item.target)
            else out += BotRow.Talk(item.id, listOf(item.target), item.ts)
        } else {
            out += BotRow.One(item)
        }
    }
    return out
}

/** Where unread replies begin: the first of the bot's replies after the reader's own last message. The desktop's `firstUnread`. */
fun firstUnread(items: List<BotItem>): String? {
    var mark: String? = null
    for (item in items) when (item) {
        is BotItem.User -> mark = null
        is BotItem.Assistant -> if (mark == null) mark = item.id
        else -> {}
    }
    return mark
}

/** Whether `unreadStart` could say: null while not yet known, else `at` (itself null for "settled, none"). */
data class Unread(val at: String?)

/**
 * Where unread replies begin among the items up to `upTo`, the last one the chat held when it
 * opened. Null while not yet known: the reader's last message may sit above what is loaded, so it
 * waits for one of theirs or the whole chat (`complete`). The desktop's `unreadStart`.
 */
fun unreadStart(items: List<BotItem>, upTo: String, complete: Boolean): Unread? {
    val i = items.indexOfFirst { it.id == upTo }
    val seen = if (i >= 0) items.subList(0, i + 1) else items
    if (!complete && seen.none { it is BotItem.User }) return null
    return Unread(firstUnread(seen))
}

/** The tool the bot is on now, for the orb line: "Bash dray session new …". Null once its turn has no call left open. */
fun currentTool(events: List<AgentEvent>): String? {
    val done = mutableSetOf<String>()
    for (e in events.asReversed()) {
        if (!e.isMain) continue
        when (val p = e.payload) {
            is Payload.UserMessage, is Payload.TurnCompleted -> return null
            is Payload.ToolCompleted -> done += p.callId
            is Payload.ToolStarted -> if (p.callId !in done) {
                val label = toolLabel(p.name, pending = true)
                return toolSummary(p.name, p.toolType, p.input)?.let { "$label $it" } ?: label
            }
            else -> {}
        }
    }
    return null
}

/** Whether the newest prompt is Dray's hidden review, whose reply never draws. */
fun inReviewTurn(events: List<AgentEvent>): Boolean {
    for (e in events.asReversed()) {
        if (!e.isMain) continue
        val p = e.payload
        if (p is Payload.UserMessage) return p.kickoff && p.text.startsWith("Review:")
    }
    return false
}

/** A reply as one plain line: no fences, heading marks, emphasis or link syntax (`previewLine`). */
fun previewLine(text: String): String {
    var s = text.replace(Regex("```[\\s\\S]*?```"), " ")
    s = s.replace(Regex("(?m)^\\s*(?:#{1,6}\\s+|>\\s?)+"), "")
    s = s.replace(Regex("[*`]+"), "")
    s = s.replace(Regex("\\[([^\\]]*)\\]\\([^)]*\\)"), "$1")
    return s.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
}

/** "Rule", "New skill", "Removed memory": `lessonKind`. */
fun lessonKind(l: Lesson): String {
    val base = mapOf("instructions" to "Rule", "skill" to "Skill", "memory" to "Memory")[l.kind] ?: "Lesson"
    return when (l.change) {
        "added" -> "New ${base.lowercase()}"
        "removed" -> "Removed ${base.lowercase()}"
        else -> base
    }
}

/** "Today 18:44", "Yesterday 18:44", "Tuesday 18:44", "Tue, Nov 10 18:21": the desktop's `chatTime`. */
fun chatTime(ms: Long, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
    val at = Instant.ofEpochMilli(ms).atZone(zone)
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val clock = at.format(DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault()))
    val days = ChronoUnit.DAYS.between(at.toLocalDate(), today)
    return when {
        days == 0L -> "Today $clock"
        days == 1L -> "Yesterday $clock"
        now - ms < 6 * 86_400_000L -> "${at.format(DateTimeFormatter.ofPattern("EEEE", Locale.getDefault()))} $clock"
        at.year == Instant.ofEpochMilli(now).atZone(zone).year ->
            "${at.format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.getDefault()))} $clock"
        else -> "${at.format(DateTimeFormatter.ofPattern("EEE, MMM d, yyyy", Locale.getDefault()))} $clock"
    }
}

// Merge verdicts

/** Why a pull request can or cannot land; `mergeVerdict` in `pr.ts`. Prefixed so the PR sheet's own port never collides. */
enum class BotVerdict { Merged, Closed, Conflict, Unknown, Draft, Behind, Blocked, Unstable, Ready }

/**
 * The order is the whole logic: a closed PR's merge state is stale, a conflict outranks everything
 * open, a draft is stored where the statuses below it are what GitHub recomputes while it says `UNKNOWN`.
 */
fun verdictOf(pr: PrMark): BotVerdict {
    val mergeable = pr.mergeable ?: "UNKNOWN"
    val status = pr.mergeStateStatus ?: "UNKNOWN"
    return when {
        pr.state == "MERGED" -> BotVerdict.Merged
        pr.state == "CLOSED" -> BotVerdict.Closed
        mergeable == "CONFLICTING" || status == "DIRTY" -> BotVerdict.Conflict
        pr.isDraft -> BotVerdict.Draft
        mergeable == "UNKNOWN" -> BotVerdict.Unknown
        status == "BEHIND" -> BotVerdict.Behind
        status == "BLOCKED" -> BotVerdict.Blocked
        status == "UNSTABLE" -> BotVerdict.Unstable
        status == "UNKNOWN" -> BotVerdict.Unknown
        else -> BotVerdict.Ready
    }
}

/** `prStatus`'s key: checks speak before the merge state, since `BLOCKED` is usually them. */
fun prStatus(pr: PrMark): String {
    val v = verdictOf(pr)
    return when {
        v == BotVerdict.Merged -> "merged"
        v == BotVerdict.Closed -> "closed"
        v == BotVerdict.Conflict -> "conflict"
        pr.checksState == "FAILING" -> "checksFailing"
        pr.checksState == "RUNNING" -> "checksRunning"
        v == BotVerdict.Draft -> "draft"
        pr.reviewDecision == "CHANGES_REQUESTED" -> "changesRequested"
        pr.reviewDecision == "REVIEW_REQUIRED" -> "needsReview"
        v == BotVerdict.Unstable -> "checksFailing"
        v == BotVerdict.Unknown -> "unknown"
        v == BotVerdict.Behind -> "behind"
        v == BotVerdict.Blocked -> "blocked"
        else -> "ready"
    }
}

/** What the merge card says for work the task left running past its turn: the one job's name, else how many. */
fun runningLabel(tasks: List<com.yogesh.dray.wire.BackgroundTask>): String? {
    if (tasks.isEmpty()) return null
    val name = if (tasks.size == 1) tasks[0].description?.trim().orEmpty() else ""
    return name.ifEmpty { tasks.size.toString() }
}

// Reading the bot's commands

data class SentTo(val target: String, val bot: Boolean)

private val startsSession = Regex("\\bdray\\s+(session\\s+new|new)\\b")
private val taskIdLine = Regex("(?im)^\\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\s*$")
/** What `dray bot send` prints, in `apps/cli/src/bot.rs`. */
private val botSentLine = Regex("(?im)^(?:Sent to|Queued for) bot \".*\" \\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\)\\.$")
/** A session id, or a prefix of one long enough to name it. */
private val sessionIdLike = Regex("(?i)^[0-9a-f][0-9a-f-]{7,}$")
private val sendsRe = Regex("\\bdray\\s+(?:(session|bot)\\s+)?send\\b")
private val heredocRe = Regex("<<-?[ \\t]*(['\"]?)(\\w+)\\1[^\\n]*\\n[\\s\\S]*?\\n[ \\t]*\\2(?=[ \\t]*(?:\\n|\\)|$))")
private val subshellRe = Regex("\\$\\(\\s*\\w+\\s+")
private val openerRe = Regex("(?<!<)<<(?!<)-?[ \\t]*(?:'([^'\\n]+)'|\"([^\"\\n]+)\"|([^\\s'\"<>;&|()]+))")

/** A Bash call's command: a string, or argv joined. */
private fun command(input: JsonElement): String? {
    val c = input["command"] ?: return null
    c.str?.let { return it }
    val parts = c.arr
    return if (parts.isEmpty() && c !is kotlinx.serialization.json.JsonArray) null else parts.mapNotNull { it.str }.joinToString(" ")
}

/** The length of `re`'s match starting exactly at `at`, or 0: JS's sticky flag. */
private fun stuck(re: Regex, s: String, at: Int): Int {
    if (at > s.length) return 0
    return re.matchAt(s, at)?.value?.length ?: 0
}

/**
 * `cmd` with every quoted string, escape and heredoc blanked to spaces, so a `dray … send` spelled
 * inside a message is never read as a command. Same length, so an index into it is an index into `cmd`.
 */
fun unquoted(cmd: String): String {
    val n = cmd.length
    val out = StringBuilder(n)
    var i = 0
    fun blank(end: Int) {
        while (i < end) { out.append(if (cmd[i] == '\n') '\n' else ' '); i++ }
    }
    val bodies = mutableListOf<String>()
    while (i < n) {
        val c = cmd[i]
        val m = if (c == '<') openerRe.matchAt(cmd, i) else null
        if (m != null) {
            bodies += (1..3).firstNotNullOfOrNull { m.groups[it]?.value } ?: ""
            blank(i + m.value.length)
        } else if (c == '\n' && bodies.isNotEmpty()) {
            out.append(c)
            i++
            for (word in bodies) {
                val close = Regex("(?m)^[ \\t]*${Regex.escape(word)}[ \\t]*$\\n?")
                // Unclosed, bash reads the body to the end of input and runs none of it.
                val hit = close.find(cmd, i)
                blank(hit?.let { it.range.last + 1 } ?: n)
            }
            bodies.clear()
        } else if (c == '\\') {
            blank(minOf(i + 2, n))
        } else if (c == '\'') {
            val end = cmd.indexOf('\'', i + 1)
            blank(if (end < 0) n else end + 1)
        } else if (c == '"') {
            var j = i + 1
            while (j < n && cmd[j] != '"') {
                val sub = if (cmd[j] == '$') stuck(subshellRe, cmd, j) else 0
                val inner = if (sub > 0) stuck(heredocRe, cmd, j + sub) else 0
                j += if (cmd[j] == '\\') 2 else if (inner > 0) sub + inner else 1
            }
            blank(minOf(j + 1, n))
        } else {
            out.append(c)
            i++
        }
    }
    return out.toString()
}

/**
 * Every `dray session send` and `dray bot send` in one command, with who to. A session send to
 * anything but an id — a loop's `"$id"` — is skipped rather than drawn as a task that opens nothing.
 */
fun sentMessages(cmd: String, plain: String): List<SentTo> {
    val n = cmd.length
    val out = mutableListOf<SentTo>()
    for (m in sendsRe.findAll(plain)) {
        val bot = m.groups[1]?.value == "bot"
        var at = m.range.last + 1
        fun skipSpace() { while (at < n && cmd[at].isWhitespace()) at++ }
        skipSpace()
        if (at >= n) continue
        val rest = cmd.substring(at)
        val q = rest[0]
        val word: String
        val length: Int
        if (q == '\'' || q == '"') {
            val end = rest.indexOf(q, 1)
            if (end < 0) continue
            word = rest.substring(1, end)
            length = word.length + 2
        } else {
            word = rest.takeWhile { !it.isWhitespace() }
            length = word.length
        }
        if (!bot && !sessionIdLike.matches(word)) continue
        at += length
        skipSpace()
        // No message after the target is no send.
        if (at >= n) continue
        out += SentTo(word, bot)
    }
    return out
}
