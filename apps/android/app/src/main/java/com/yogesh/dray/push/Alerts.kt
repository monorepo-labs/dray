package com.yogesh.dray.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.yogesh.dray.MainActivity
import com.yogesh.dray.R
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.wire.arr
import com.yogesh.dray.wire.bool
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.str
import com.yogesh.dray.wire.wireJson
import kotlinx.serialization.json.JsonObject

/** What the relay sends in an FCM message's `data`: the alert's words, its tag, and the iPhone's `dray` object as JSON. */
data class PushAlert(
    val kind: String,
    val server: String,
    val session: String,
    /** The chat a tap opens where not `session`: a bot's task opens the bot's chat. */
    val open: String?,
    val title: String,
    val body: String,
    /** What a newer alert replaces: a Done or Ready per chat, an ask per request. */
    val tag: String,
    val request: String?,
    val allow: String?,
    val deny: String?,
    val question: Question?,
) {
    data class Question(val text: String, val options: List<String>, val freeText: Boolean)

    /** The chat the alert belongs to on screen; actions still answer `session`. */
    val key: SessionKey get() = SessionKey(server, open ?: session)

    /** Back into the `data` map, for an action's intent and a debug build's stand-in. */
    fun data(): Map<String, String> = mapOf(
        "title" to title, "body" to body, "tag" to tag,
        "dray" to jsonOf(
            "kind" to kind, "server" to server, "session" to session, "open" to open, "request" to request,
            "allow" to allow, "deny" to deny,
            "question" to question?.let { jsonOf("text" to it.text, "options" to it.options, "freeText" to it.freeText) },
        ).toString(),
    )

    companion object {
        fun parse(data: Map<String, String>): PushAlert? {
            val d = runCatching { wireJson.parseToJsonElement(data["dray"] ?: return null) as? JsonObject }.getOrNull() ?: return null
            val kind = d["kind"].str ?: return null
            val server = d["server"].str ?: return null
            val session = d["session"].str ?: return null
            return PushAlert(
                kind, server, session, d["open"].str,
                data["title"] ?: "Dray", data["body"].orEmpty(), data["tag"] ?: "$kind-$session",
                d["request"].str, d["allow"].str, d["deny"].str,
                d["question"]?.let { q -> q["text"].str?.let { PushAlert.Question(it, q["options"].arr.mapNotNull { o -> o.str }, q["freeText"].bool == true) } },
            )
        }
    }
}

/** Draws alerts: a channel per kind, so Android's own settings can silence one, and each kind's buttons. */
object Alerts {
    private val channelNames = mapOf(
        "done" to "Tasks done", "permission" to "Permission requests",
        "question" to "Questions", "ready" to "Ready to merge",
    )

    fun channels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = context.getSystemService(NotificationManager::class.java)
        for ((kind, name) in channelNames) {
            // An ask blocks a task until answered, so it comes in loud; a Done can wait.
            val importance = if (kind == "done" || kind == "ready") NotificationManager.IMPORTANCE_DEFAULT else NotificationManager.IMPORTANCE_HIGH
            nm.createNotificationChannel(NotificationChannel(channel(kind), name, importance))
        }
    }

    private fun channel(kind: String) = "dray.${if (kind in channelNames) kind else "done"}"

    /** Shows an alert, unless its chat is the one on screen. */
    fun show(context: Context, a: PushAlert) {
        // The phone's own switches decide last: a server unreachable when one was turned off, or a message
        // queued before it, still sends what this phone no longer wants.
        if (!Push.enabled || !Push.kindOn(a.kind)) return
        if (Push.foreground && Push.viewing.let { it == a.key || it == Push.shownAs(a.key) }) return
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val open = Intent(context, MainActivity::class.java)
            .setAction(OPEN)
            .putExtra(EXTRA_SERVER, a.server)
            .putExtra(EXTRA_CHAT, a.open ?: a.session)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val n = NotificationCompat.Builder(context, channel(a.kind))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(a.title)
            .setContentText(a.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(a.body))
            .setAutoCancel(true)
            .setCategory(if (a.kind == "done" || a.kind == "ready") NotificationCompat.CATEGORY_STATUS else NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(PendingIntent.getActivity(context, a.tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        for (action in actions(context, a)) n.addAction(action)
        NotificationManagerCompat.from(context).notify(a.tag, 0, n.build())
    }

    fun dismiss(context: Context, tag: String) = NotificationManagerCompat.from(context).cancel(tag, 0)

    /**
     * Allow and Deny on a permission; a question's options, and Reply where any answer goes. Android
     * shows three buttons at most, so a question with more options than fit gets none of them and a
     * tap opens the app, where every option is: a button never answers something it doesn't say.
     */
    private fun actions(context: Context, a: PushAlert): List<NotificationCompat.Action> {
        val request = a.request ?: return emptyList()
        fun button(id: String, title: String, reply: Boolean = false): NotificationCompat.Action {
            val intent = Intent(context, PushActions::class.java).setAction(PushActions.ANSWER)
                .putExtra(PushActions.EXTRA_ACTION, id)
            for ((k, v) in a.data()) intent.putExtra("data.$k", v)
            // A reply's text is written into the intent by the system, so that one alone is mutable.
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (reply && Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE)
            val pending = PendingIntent.getBroadcast(context, "$request/$id".hashCode(), intent, flags)
            val b = NotificationCompat.Action.Builder(0, title, pending)
            if (reply) b.addRemoteInput(RemoteInput.Builder(PushActions.REPLY).setLabel("Your answer").build()).setAllowGeneratedReplies(false)
            return b.build()
        }
        return when (a.kind) {
            "permission" -> listOfNotNull(a.allow?.let { button("allow", "Allow") }, a.deny?.let { button("deny", "Deny") })
            "question" -> {
                val q = a.question ?: return emptyList()
                val options = if (q.options.size <= 3) q.options.mapIndexed { i, o -> button("q.$i", o) } else emptyList()
                if (q.freeText && options.size < 3) options + button("q.text", "Reply", reply = true) else options
            }
            else -> emptyList()
        }
    }

    const val OPEN = "com.yogesh.dray.OPEN_CHAT"
    const val EXTRA_SERVER = "dray.server"
    const val EXTRA_CHAT = "dray.chat"
}
