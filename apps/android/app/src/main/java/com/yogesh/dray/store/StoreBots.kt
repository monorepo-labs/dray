package com.yogesh.dray.store

import androidx.compose.runtime.mutableStateMapOf
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.ProjectKey
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.prStatus
import com.yogesh.dray.model.sessionBranch
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.wire.AgentEvent
import com.yogesh.dray.wire.Bot
import com.yogesh.dray.wire.BotPreview
import com.yogesh.dray.wire.BotStalls
import com.yogesh.dray.wire.DrayError
import com.yogesh.dray.wire.Payload
import com.yogesh.dray.wire.PrMark
import com.yogesh.dray.wire.Queued
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.Snapshot
import com.yogesh.dray.wire.StallRow
import com.yogesh.dray.wire.StatusEvent
import com.yogesh.dray.wire.arr
import com.yogesh.dray.wire.bool
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.int
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.sentFrom
import com.yogesh.dray.wire.parseDate
import com.yogesh.dray.wire.str
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.util.UUID

// The bot half of iOS's Store.swift: bot chats, their tasks, previews, stalls and agent switches.

/** An agent and model picked in a bot's sheet, waiting for the chat's next message. */
data class AgentPick(val harness: String, val model: String)

/** What the store holds for bots beyond the list itself. */
class BotState {
    /** Each bot chat's newest reply and unread count, read off the log's end by its server. */
    val previews = mutableStateMapOf<SessionKey, BotPreview>()
    /** Each server's "Waiting on you" cards by bot id, where it judges them (#1259); absent is a server too old to. */
    val stallCards = mutableStateMapOf<String, Map<String, BotStalls>>()
    /** A chat's agent and model for its next message, a bot's or a task's: the desktop's `unsentPicks`. */
    val unsent = mutableStateMapOf<SessionKey, AgentPick>()
    /** The session an agent switch goes to, minted once and kept until it lands. */
    internal val switches = mutableMapOf<SessionKey, SessionKey>()
}

/** A bot's task that waits on the reader: a PR ready to merge, or a task gone quiet. */
data class Stall(
    val task: SessionKey,
    val item: SessionItem,
    val pr: PrMark?,
    val ready: Boolean,
    /** Set on a row the bot's server judged, whose key it names. */
    val judged: StallRow? = null,
    /** Whether the phone holds the task itself, rather than only its server's word. */
    val held: Boolean = true,
) {
    val id: String get() = judged?.key ?: "${task.id}:${if (ready) "ready:${pr?.number ?: 0}" else "waiting"}:${item.modified}"
    /** A ready PR GitHub is working out again: drawn, not mergeable. */
    val checking: Boolean get() = judged?.checking ?: false
    /** Nothing to open: its machine is down, or one this phone holds no link to. */
    val offline: Boolean get() = judged?.let { it.offline || it.machine != null && !held } ?: false
}

/** How long a task sits before it counts as waiting (`STALL_MS`), for a server too old to judge. */
private const val STALL_AFTER_MS = 5 * 60_000L

/** Every live server's bots, in its own order, servers in the list's. */
val Store.allBots: List<Pair<String, Bot>> get() = live.flatMap { s -> bots[s.id].orEmpty().map { s.id to it } }

/** A bot's chat: every unsettled session in its folder, oldest first. The newest is the one a reply goes to. */
fun Store.botChat(server: String, bot: Bot): List<SessionKey> =
    items.filter { (k, v) -> k.server == server && v.archived != true && v.routineRun == null && samePath(v.cwd, bot.path) }
        .entries.sortedBy { it.value.created ?: it.value.modified }.map { it.key }

/**
 * A bot's tasks at any depth under any of its chat's sessions, newest created first at each level;
 * settled ones drop, and a sub-task of one hangs under the session that adopted it. Every live
 * server's, since `--machine` puts a task on another one that still names the bot's session as its parent.
 */
fun Store.botTasks(chat: List<SessionKey>): List<SessionKey> {
    // One copy per id: a machine paired directly and shared too lists a task twice.
    val copies = mutableMapOf<String, Pair<SessionKey, SessionItem>>()
    for ((key, item) in items) {
        if (item.archived == true || item.routineRun != null || item.parentSessionId == null || item.parentSessionId == item.sessionId) continue
        val held = copies[item.sessionId]
        if (held != null && serverState[held.first.server] == ConnState.Connected) continue
        copies[item.sessionId] = key to item
    }
    val live = items.filter { it.value.archived != true }.keys.map { it.id }.toSet()
    val kids = mutableMapOf<String, MutableList<Pair<SessionKey, SessionItem>>>()
    for (copy in copies.values) {
        val parent = copy.second.parentSessionId
        val p = parent?.takeIf { it in live } ?: copy.second.adoptedBy ?: parent ?: continue
        kids.getOrPut(p) { mutableListOf() } += copy
    }
    val out = mutableListOf<SessionKey>()
    val seen = chat.map { it.id }.toMutableSet()
    fun walk(ids: List<String>) {
        val level = ids.flatMap { kids[it].orEmpty() }.sortedByDescending { it.second.created ?: it.second.modified }
        for (kid in level) if (seen.add(kid.second.sessionId)) {
            out += kid.first
            walk(listOf(kid.second.sessionId))
        }
    }
    walk(chat.reversed().map { it.id })
    return out
}

/** The first card each hidden one of `tasks` is stopped on, drawn in the chat that started it. */
fun Store.hiddenAsks(tasks: List<SessionKey>): List<Pair<SessionKey, AgentEvent>> =
    tasks.mapNotNull { k -> if (items[k]?.hidden == true) asks[k]?.firstOrNull()?.let { k to it } else null }

suspend fun Store.loadPreviews(server: String) {
    val chats = bots[server].orEmpty().mapNotNull { botChat(server, it).lastOrNull() }
    if (chats.isEmpty()) return
    val read = runCatching { call(server, "bot_previews", jsonOf("sessionIds" to chats.map { it.id })) }.getOrNull() as? JsonObject ?: return
    for ((id, p) in read) decodeOrNull<BotPreview>(p)?.let { botState.previews[SessionKey(server, id)] = it }
}

/** Reads a repo's PR marks if none are held, for a merge card or task on a repo no row lists. */
suspend fun Store.ensureMarks(server: String, path: String) = loadMarks(server, force = false, only = setOf(path))

/** Whether a repo's marks have been read at all: a PR missing from them then is one GitHub no longer lists. */
fun Store.marksRead(server: String, path: String) = marks[ProjectKey(server, path)] != null

/**
 * Lands a bot task's PR. The server settles the task and removes its worktree once it lands
 * (`settle`); a server from before that answers null, and the task is settled from here.
 */
suspend fun Store.mergeTask(server: String, taskId: String, cwd: String, number: Int, branch: String, method: String): Boolean {
    val settling = try {
        call(server, "merge_pr", jsonOf("cwd" to cwd, "number" to number, "method" to method, "settle" to taskId), timeoutMs = 120_000)
    } catch (e: Exception) {
        lastError = e.message
        return false
    }
    loadMarks(server, force = true, only = setOf(cwd))
    val key = SessionKey(server, taskId)
    val item = items[key]
    if (settling.bool == true || item == null || item.archived == true || item.busy) return true
    val removed = item.worktreeRemoved ?: false
    val observed = if (removed) null else runCatching { call(server, "work_status", jsonOf("cwd" to item.cwd))["branch"].str }.getOrNull()
    if (!removed && observed == null) return true
    if (sessionBranch(item.branch, item.worktreeName, removed, observed) != branch) return true
    runCatching { call(server, "set_session_flags", jsonOf("sessionId" to taskId, "archived" to true)) }
    if (item.worktreeName != null && !removed) {
        val d = runCatching { call(server, "worktree_disposition", jsonOf("sessionId" to taskId)) }.getOrNull()
        if (d != null && (d["exists"].bool == false || (d["changedFiles"].int == 0 && d["unpushedCommits"].int == 0))) {
            runCatching { call(server, "remove_session_worktree", jsonOf("sessionId" to taskId)) }
        }
    }
    return true
}

/**
 * A bot chat's reply. Another `harness` than the chat runs is an agent switch: a new session in
 * the bot's folder, which the server hands the chat so far. Answers the session it went to.
 */
suspend fun Store.botSend(
    key: SessionKey, text: String, harness: String?, model: String?, effort: String?, stance: String?, fast: Boolean?,
): SessionKey? {
    val item = items[key] ?: return null
    if (harness == null || harness == item.harness) {
        return if (send(key, text, model, effort, stance, fast, effortMoved = effort != null)) key.also { botState.unsent.remove(key) } else null
    }
    return try {
        val fresh = decodeOrNull<SessionItem>(call(key.server, "get_session_by_id", jsonOf("sessionId" to key.id, "turns" to 0)))
            ?: throw DrayError("Session not found")
        created(key.server, fresh)
        // One id per switch, kept across retries: a switch whose reply was lost already made its session.
        var to = botState.switches[key] ?: SessionKey(key.server, UUID.randomUUID().toString())
        botState.switches[key] = to
        val made = runCatching { decodeOrNull<SessionItem>(call(key.server, "get_session_by_id", jsonOf("sessionId" to to.id, "turns" to 0))) }.getOrNull()
        if (made != null) {
            created(key.server, made)
            // The index entry lands before the agent starts: the words landed only if its log holds them.
            val log = Snapshot.decode(call(key.server, "get_session_by_id", jsonOf("sessionId" to to.id, "turns" to 1)))
            if (log?.events?.any { it.payload is Payload.UserMessage } == true) {
                botState.switches.remove(key)
                botState.unsent.remove(key)
                return to
            }
            if (made.busy) throw DrayError("The switch is still starting. Try again in a moment.")
            // Its agent never started: a new one, rather than resume a thread that was never made.
            to = SessionKey(key.server, UUID.randomUUID().toString())
            botState.switches[key] = to
        }
        // The desktop's rule: the old agent's turn would be cut off by the switch.
        if (fresh.busy) throw DrayError("Wait for this turn to end to switch agent.")
        val reply = call(
            key.server, "send_msg",
            jsonOf(
                "sessionId" to to.id, "prompt" to text, "attachmentPaths" to emptyList<String>(),
                "harness" to harness, "model" to (model ?: Picks.defaultModel[harness] ?: ""), "effort" to effort,
                "permissionMode" to Picks.stanceFor(harness, stance ?: fresh.permissionMode), "fast" to (fast ?: false),
                "cwd" to fresh.cwd, "branch" to null, "useWorktree" to false, "worktreeName" to null, "baseRef" to null,
                "isNewSession" to true, *sentFrom(),
            ),
        )
        decodeOrNull<SessionItem>(reply["snapshot"])?.let { created(key.server, it) }
        decodeOrNull<Queued>(reply["queued"])?.let { q -> if (queued[to]?.contains(q) != true) queued[to] = queued[to].orEmpty() + q }
        botState.unsent.remove(key)
        botState.switches.remove(key)
        sends[to] = (sends[to] ?: 0) + 1
        to
    } catch (e: Exception) {
        lastError = e.message
        null
    }
}

/** The card `botId`'s server judged, as rows to draw; null where it is too old to judge or not connected. */
fun Store.judgedStalls(server: String, botId: String, tasks: List<SessionKey>, now: Long): List<Stall>? {
    if (serverState[server] != ConnState.Connected) return null
    val cards = botState.stallCards[server] ?: return null
    val card = cards[botId]
    val known = card?.judged.orEmpty().toSet()
    val local = stalls(tasks.filter { it.id !in known }, now)
    val judged = card?.rows.orEmpty().mapNotNull { r ->
        val key = tasks.firstOrNull { it.id == r.item.sessionId } ?: items.keys.firstOrNull { it.id == r.item.sessionId }
        val own = key?.let { items[it] }
        if (key != null && own != null) {
            if (own.modified != r.item.modified || own.busy || isAsking(key)) null
            else Stall(key, own, r.pr, r.kind == "ready", r)
        } else {
            Stall(SessionKey(server, r.item.sessionId), r.item, r.pr, r.kind == "ready", r, held = false)
        }
    }
    // The server's rows hold their order; the phone's own go after them.
    return judged + local
}

/** The phone's own judgement, for a server too old to send one. */
fun Store.stalls(tasks: List<SessionKey>, now: Long = System.currentTimeMillis()): List<Stall> =
    tasks.mapNotNull { key ->
        val item = items[key] ?: return@mapNotNull null
        if (item.busy || isAsking(key) || inBackground(key) || item.aside == true) return@mapNotNull null
        val touched = parseDate(item.modified) ?: return@mapNotNull null
        if (now - touched < STALL_AFTER_MS) return@mapNotNull null
        val pr = prMark(key, item)
        // A draft's red check is stale by design, so it waits on the reader like any draft.
        val status = pr?.let { if (it.isDraft && prStatus(it) == "checksFailing") "draft" else prStatus(it) }
        when (status) {
            "unknown", "checksRunning", "merged" -> null
            "ready" -> Stall(key, item, pr, true)
            // The task's to mend, through its bot: never the reader's card.
            "conflict", "checksFailing", "behind", "changesRequested" -> null
            else -> Stall(key, item, pr, false)
        }
    }.sortedBy { it.item.modified }

/** The bot frames: stall cards, and a bot row's preview once its turn ends. Called before the store's own handling. */
internal fun Store.botFrame(server: String, name: String, payload: JsonElement?) {
    when (name) {
        "live_state" -> {
            val list = payload["stalls"]
            if (list == null) botState.stallCards.remove(server)
            else botState.stallCards[server] = list.arr.mapNotNull { BotStalls.decode(it) }.associateBy { it.botId }
        }
        // Only from a server that judges stalls, whose `live_state` already said so.
        "bot_stalls_changed" -> BotStalls.decode(payload)?.let { card ->
            botState.stallCards[server] = botState.stallCards[server].orEmpty() + (card.botId to card)
        }
        "session_status" -> decodeOrNull<StatusEvent>(payload)?.let { s ->
            // A bot's row shows its newest reply, which only its server can read.
            if (s.status != "in_progress" && bot(SessionKey(server, s.sessionId)) != null) scope.launch { loadPreviews(server) }
        }
    }
}
