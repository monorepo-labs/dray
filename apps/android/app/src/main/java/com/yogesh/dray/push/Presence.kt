package com.yogesh.dray.push

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.store.Store
import com.yogesh.dray.wire.jsonOf
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Well inside the server's 60s lease, so a held chat never lapses mid-read. */
const val RENEW_MS = 20_000L

/** What was last said to a server: its sessions, and when. */
data class Said(val sessions: List<String>, val at: Long)

/**
 * The sessions to say to each server now, given the chat on screen and what each was last told:
 * presence.ts's `due`. A server is told again when its list changed or its lease is due, and told
 * nothing at all while nothing changed and nothing is held.
 */
fun due(shown: SessionKey?, looking: Boolean, said: Map<String, Said>, now: Long): Map<String, List<String>> {
    val want = if (looking && shown != null) mapOf(shown.server to listOf(shown.id)) else emptyMap()
    val out = mutableMapOf<String, List<String>>()
    for (server in said.keys + want.keys) {
        val sessions = want[server].orEmpty()
        val last = said[server]
        if (if (last == null) sessions.isEmpty() else last.sessions == sessions && now - last.at < RENEW_MS) continue
        out[server] = sessions
    }
    return out
}

/**
 * Tells each server which of its chats is on this phone's screen, so it holds that chat's push
 * for every phone of the reader's (#1661, the desktop's presence.ts). Looking = the app in front
 * with a chat open; going to the background says "nothing" before the sockets go quiet.
 */
object Presence {
    private lateinit var store: Store
    private var shown: SessionKey? = null
    private var foreground = false
    private val said = mutableMapOf<String, Said>()
    /** Servers from before `set_viewing`, asked again only after they reconnect, so a renewal never resends. */
    private val unsupported = mutableSetOf<String>()
    private var renewing: Job? = null

    fun start(store: Store) {
        this.store = store
        store.onConnected += ::connected
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                foreground = true
                report()
                // Checked often and sent only once due, so a renewal lands 20 to 25s after the last word.
                renewing = store.scope.launch {
                    while (true) {
                        delay(5_000)
                        report()
                    }
                }
            }

            override fun onStop(owner: LifecycleOwner) {
                foreground = false
                renewing?.cancel()
                report()
            }
        })
    }

    /** The chat on screen now, or none. */
    fun show(key: SessionKey?) {
        if (key == shown) return
        shown = key
        if (::store.isInitialized) report()
    }

    /** A fresh socket holds nothing of what the old one said, and may be a server updated since. */
    private fun connected(server: String) {
        said.remove(server)
        unsupported.remove(server)
        report()
    }

    private fun report() {
        val now = System.currentTimeMillis()
        for ((server, sessions) in due(shown, foreground, said, now)) {
            if (sessions.isEmpty()) said.remove(server) else said[server] = Said(sessions, now)
            if (server in unsupported) continue
            store.scope.launch {
                runCatching {
                    store.call(server, "set_viewing", jsonOf("sessions" to sessions))
                }.onFailure {
                    if (it.message?.contains("unknown command") == true) unsupported += server
                    // Not said after all: the next renewal or reconnect tries again.
                    else if (said[server]?.sessions == sessions) said.remove(server)
                }
            }
        }
    }
}
