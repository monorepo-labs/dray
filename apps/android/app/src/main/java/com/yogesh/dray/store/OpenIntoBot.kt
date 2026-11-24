package com.yogesh.dray.store

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.yogesh.dray.wire.Bot

/**
 * Settings' "Open into a bot": off unless turned on, and then the app opens on the picked bot's
 * chat at launch, back going to the list. Kept on the phone, never on a server.
 */
object OpenIntoBot {
    private lateinit var app: Context
    private val prefs by lazy { app.getSharedPreferences("settings", Context.MODE_PRIVATE) }

    var on by mutableStateOf(false)
        private set
    /** The picked bot as server and bot id; none picked means the first bot. */
    var picked by mutableStateOf<Pair<String, String>?>(null)
        private set

    fun start(context: Context) {
        app = context.applicationContext
        on = prefs.getBoolean(ON_KEY, false)
        val server = prefs.getString(SERVER_KEY, null)
        val bot = prefs.getString(BOT_KEY, null)
        picked = if (server != null && bot != null) server to bot else null
    }

    fun turn(on: Boolean) {
        this.on = on
        prefs.edit().putBoolean(ON_KEY, on).apply()
    }

    fun pick(server: String, bot: String) {
        picked = server to bot
        prefs.edit().putString(SERVER_KEY, server).putString(BOT_KEY, bot).apply()
    }

    /** The bot to open: the picked one while it still exists, else the first. */
    fun target(bots: List<Pair<String, Bot>>): Pair<String, Bot>? =
        bots.firstOrNull { (s, b) -> s == picked?.first && b.id == picked?.second } ?: bots.firstOrNull()

    private const val ON_KEY = "openIntoBot"
    private const val SERVER_KEY = "openIntoBot.server"
    private const val BOT_KEY = "openIntoBot.bot"
}
