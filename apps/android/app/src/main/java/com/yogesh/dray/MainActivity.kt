package com.yogesh.dray

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.net.PairLink
import com.yogesh.dray.push.Alerts
import com.yogesh.dray.push.Push
import com.yogesh.dray.push.PushAlert
import com.yogesh.dray.wire.str
import com.yogesh.dray.wire.wireJson
import kotlinx.serialization.json.JsonObject
import com.yogesh.dray.ui.App
import com.yogesh.dray.ui.DrayTheme
import com.yogesh.dray.ui.LocalStore

class MainActivity : ComponentActivity() {
    /** A `dray://connect` link the app was opened with, waiting for the add screen to take it. */
    private var incoming by mutableStateOf<PairLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) take(intent)
        val store = (application as DrayApplication).store
        setContent {
            DrayTheme {
                CompositionLocalProvider(LocalStore provides store) {
                    App(incoming) { incoming = null }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        take(intent)
    }

    private fun take(intent: Intent?) {
        intent?.dataString?.let { PairLink.parse(it) }?.let { incoming = it }
        // A tapped alert opens its chat.
        if (intent?.action == Alerts.OPEN) {
            val server = intent.getStringExtra(Alerts.EXTRA_SERVER)
            val chat = intent.getStringExtra(Alerts.EXTRA_CHAT)
            if (server != null && chat != null) Push.opening = SessionKey(server, chat)
        }
        if (BuildConfig.DEBUG) debugPush(intent)
    }

    /**
     * A debug build's stand-ins for what FCM can't do here: `pushRelay` points sealing at a local
     * relay, and `pushPayload` is an FCM message's `data` as the relay sent it, drawn in 3s as
     * `PushService` would, so the app can be sent to the background first.
     */
    private fun debugPush(intent: Intent?) {
        intent?.getStringExtra("pushRelay")?.let { Push.useRelay(it) }
        val payload = intent?.getStringExtra("pushPayload") ?: return
        val data = runCatching {
            (wireJson.parseToJsonElement(payload) as JsonObject).mapValues { (_, v) -> v.str ?: v.toString() }
        }.getOrNull() ?: return
        val alert = PushAlert.parse(data) ?: return
        android.os.Handler(mainLooper).postDelayed({ Alerts.show(applicationContext, alert) }, 3000)
    }
}
