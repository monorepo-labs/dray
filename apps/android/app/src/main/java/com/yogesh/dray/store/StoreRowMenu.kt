package com.yogesh.dray.store

import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.wire.Bot
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.jsonOf
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

// A task row's long-press menu: the desktop sidebar's `RowMenu`, through the same server commands.

/** Writes a row's flags. The answer replaces the row here; `session_changed` carries it to other clients. */
suspend fun Store.setFlags(key: SessionKey, flags: Map<String, Boolean>) {
    try {
        val args = JsonObject(flags.mapValues { JsonPrimitive(it.value) } + ("sessionId" to JsonPrimitive(key.id)))
        decodeOrNull<SessionItem>(call(key.server, "set_session_flags", args))?.let { setItem(key, merged(key, it)) }
    } catch (e: Exception) {
        lastError = e.message
    }
}

/**
 * Takes a read, finished session's unread mark back. Not echoed by the server, so set here once
 * it agrees: set first, an offline phone showed a mark the next read took away.
 */
suspend fun Store.markUnread(key: SessionKey) {
    try {
        call(key.server, "mark_session_read", jsonOf("sessionId" to key.id, "read" to false))
    } catch (e: Exception) {
        lastError = e.message
        return
    }
    // Still idle only: a turn another client started while this was out must keep its in_progress.
    items[key]?.takeIf { it.status == "idle" }?.let { setItem(key, it.copy(status = "completed")) }
}

/**
 * Copies a session onto a new id, `worktree` giving the copy a tree of its own. Answers the fork's
 * key; nothing spawns until its first send.
 */
suspend fun Store.fork(key: SessionKey, worktree: Boolean): SessionKey? = try {
    // The app picks the id and the CLI adopts it, as for a new session.
    val args = jsonOf("sessionId" to key.id, "forkId" to UUID.randomUUID().toString(), "worktree" to worktree)
    val item = decodeOrNull<SessionItem>(call(key.server, "fork_session", args, timeoutMs = 120_000))
        ?: error("The server didn't answer with the fork.")
    created(key.server, item)
    SessionKey(key.server, item.sessionId)
} catch (e: Exception) {
    lastError = e.message
    null
}

/** Cuts a spawned session loose from its parent, so the list stops nesting it. */
suspend fun Store.detach(key: SessionKey) {
    try {
        decodeOrNull<SessionItem>(call(key.server, "detach_session", jsonOf("sessionId" to key.id)))?.let { setItem(key, merged(key, it)) }
    } catch (e: Exception) {
        lastError = e.message
    }
}

/**
 * The bots a row can be handed to: on its own server, with a chat to hang under. None for a
 * settled row, a bot's own chat or a task already in a bot's tree — the server refuses each, so
 * the menu never offers it (`attach_to_bot`). A bot on another machine is never offered either,
 * since the list is the row's own server's.
 */
fun Store.attachTargets(key: SessionKey, item: SessionItem): List<Bot> {
    if (item.archived == true || inBotTree(key)) return emptyList()
    return bots[key.server].orEmpty().filter { botChat(key.server, it).isNotEmpty() }
}

/** Whether `key` is a bot's chat or descends from one, through parents this server lists. Bounded as the server's walk is. */
private fun Store.inBotTree(key: SessionKey): Boolean {
    var at: SessionKey? = key
    repeat(8) {
        val k = at ?: return false
        val item = items[k] ?: return false
        if (bot(k) != null) return true
        at = (item.parentSessionId ?: item.adoptedBy)?.let { SessionKey(k.server, it) }
    }
    return false
}

/** Hands a task to a bot, detach's reverse: it comes back hidden under the bot's chat, off the list and into the bot's Tasks. */
suspend fun Store.attach(key: SessionKey, bot: Bot): Boolean = try {
    decodeOrNull<SessionItem>(call(key.server, "attach_session", jsonOf("sessionId" to key.id, "bot" to bot.id)))
        ?.let { setItem(key, merged(key, it)) }
    true
} catch (e: Exception) {
    lastError = e.message
    false
}

/**
 * Deletes a session for good, its hidden children with it; false where the server refused. No
 * event says so to other clients, so the row goes here once the server agrees.
 */
suspend fun Store.delete(key: SessionKey): Boolean {
    try {
        call(key.server, "delete_session", jsonOf("sessionId" to key.id))
    } catch (e: Exception) {
        lastError = e.message
        return false
    }
    setItem(key, null)
    asks.remove(key)
    transcripts.remove(key)
    return true
}
