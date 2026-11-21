package com.yogesh.dray.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.RemoteInput
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.yogesh.dray.DrayApplication
import com.yogesh.dray.wire.jsonOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/** Where FCM hands the app a token and its messages. Every message is data alone, drawn here. */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Log.i(Push.TAG, "FCM gave a new token")
        // The application is up before any service, and with it the store Push was started on.
        (application as DrayApplication).store.scope.launch { Push.registered(token) }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val alert = PushAlert.parse(message.data)
        if (alert == null) Log.w(Push.TAG, "an FCM message with no alert in it") else Alerts.show(this, alert)
    }
}

/**
 * An alert's buttons. Allow, Deny, an option or a typed reply answers the task from the alert, the
 * app never coming forward; a failure says so the same way, and a tap on that opens the chat.
 */
class PushActions : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ANSWER) return
        val data = intent.extras?.keySet().orEmpty().filter { it.startsWith("data.") }
            .associate { it.removePrefix("data.") to intent.getStringExtra(it).orEmpty() }
        val alert = PushAlert.parse(data) ?: return
        val action = intent.getStringExtra(EXTRA_ACTION) ?: return
        val typed = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(REPLY)?.toString()
        val request = alert.request ?: return
        val args = mutableMapOf<String, Any?>("sessionId" to alert.session, "requestId" to request)
        val cmd = when {
            action == "allow" || action == "deny" -> {
                args["optionId"] = (if (action == "allow") alert.allow else alert.deny) ?: return
                "respond_permission"
            }
            action.startsWith("q.") -> {
                val q = alert.question ?: return
                val answer = if (action == "q.text") typed else action.removePrefix("q.").toIntOrNull()?.let { q.options.getOrNull(it) }
                if (answer.isNullOrBlank()) return
                args["answers"] = mapOf(q.text to answer)
                "answer_questions"
            }
            else -> return
        }
        val pending = goAsync()
        scope.launch {
            try {
                // A receiver has about ten seconds before Android calls the app stuck.
                withTimeout(9_000) { Push.answer(alert.server, cmd, jsonOf(*args.toList().toTypedArray())) }
                Log.i(Push.TAG, "$cmd sent from an alert")
                Alerts.dismiss(context, alert.tag)
            } catch (e: Exception) {
                val why = if (e is kotlinx.coroutines.TimeoutCancellationException) "the server took too long" else e.message ?: "unknown error"
                Log.e(Push.TAG, "$cmd from an alert failed: $why")
                // Said where the reader is looking: they answered from an alert, so it answers back the same way.
                Alerts.show(context, alert.copy(kind = "done", body = "Couldn't send your answer: $why. Tap to answer in Dray.", request = null))
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ANSWER = "com.yogesh.dray.push.ANSWER"
        const val EXTRA_ACTION = "dray.action"
        const val REPLY = "dray.reply"
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    }
}
