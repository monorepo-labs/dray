package com.yogesh.dray.push

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.yogesh.dray.BuildConfig
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.net.Connection
import com.yogesh.dray.net.http
import com.yogesh.dray.store.Server
import com.yogesh.dray.store.Store
import com.yogesh.dray.wire.DrayError
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.str
import com.yogesh.dray.wire.wireJson
import com.yogesh.dray.wire.get
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Phone alerts (#1299): a task done, a permission or a question asked, a PR ready to merge.
 * Push.swift's client side, on FCM.
 *
 * FCM gives the app a token; the relay on drayhq.com seals it into a handle, and every server
 * this phone connects to is handed that handle with the phone's own id for the server, which
 * each alert carries back. The server sends through the relay, the only holder of the FCM key.
 * A build without the Firebase project's `google-services.json` has no FCM, and says so.
 */
object Push {
    const val ALLOW_KEY = "notify.allow"

    /** Each kind a server can send, as its switch in Settings says it. All on until turned off. */
    val kinds = listOf(
        "done" to "A task is done", "permission" to "A task needs permission",
        "question" to "A task asks a question", "ready" to "A PR is ready to merge",
    )
    fun key(kind: String) = "notify.$kind"

    private lateinit var app: Context
    private lateinit var store: Store
    private val prefs by lazy { app.getSharedPreferences("push", Context.MODE_PRIVATE) }

    /** Whether this build carries a Firebase project at all. */
    var available by mutableStateOf(false)
        private set
    var enabled by mutableStateOf(true)
        private set
    /** Android 13 and up ask before any alert shows; the root view answers this with the prompt. */
    var wantsPermission by mutableStateOf(false)
    /** A chat a tapped alert asks to open, taken by the root view. */
    var opening by mutableStateOf<SessionKey?>(null)
    /** The chat on screen, which raises no alert of its own while the app is in front. */
    @Volatile var viewing: SessionKey? = null
    @Volatile var foreground = false
        private set

    fun kindOn(kind: String) = prefs.getBoolean(key(kind), true)

    /** The kinds turned off, which every server is told, so a kind added later reaches this phone. */
    private val off: List<String> get() = kinds.map { it.first }.filter { !kindOn(it) }

    /** drayhq.com, or a local relay a debug build was handed. */
    private val relay: String get() = prefs.getString("relay", null) ?: BuildConfig.PUSH_RELAY

    /** The token sealed, or being sealed, this launch. */
    private var sealing: String? = null

    private var handle: String?
        get() = prefs.getString("handle", null)
        set(v) = prefs.edit().putString("handle", v).apply()

    fun start(context: Context, store: Store) {
        app = context.applicationContext
        this.store = store
        available = FirebaseApp.getApps(app).isNotEmpty()
        enabled = prefs.getBoolean(ALLOW_KEY, true)
        Alerts.channels(app)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { foreground = true }
            override fun onStop(owner: LifecycleOwner) { foreground = false }
        })
        store.onConnected = ::connected
        store.onRemoving = ::leave
        if (!available) Log.i(TAG, "no Firebase project in this build: push is off")
        // Every launch: a restored phone or a cleared app gets a new token, and a new relay secret wants a new seal.
        if (enabled && handle != null) ask()
    }

    /** A debug build's `pushRelay` intent extra: a local relay to seal with and send through. */
    fun useRelay(url: String) {
        if (BuildConfig.DEBUG) prefs.edit().putString("relay", url.trimEnd('/')).apply()
    }

    /** Whether Android lets Dray's alerts show: the runtime permission, or notifications blocked for the app. */
    fun allowedBySystem(): Boolean = NotificationManagerCompat.from(app).areNotificationsEnabled()

    private fun needsAsking(): Boolean = Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    /** Asks Android first where it must, then FCM; the token comes back to `registered`. */
    private fun ask() {
        if (!enabled || !available) return
        if (needsAsking()) {
            wantsPermission = true
            return
        }
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token -> store.scope.launch { registered(token) } }
            .addOnFailureListener { Log.e(TAG, "FCM gave no token: ${it.message}") }
    }

    /** The root view's prompt answered. Turned down, nothing is asked of FCM, as iOS does. */
    fun permissionAnswered(granted: Boolean) {
        wantsPermission = false
        if (granted) ask() else Log.i(TAG, "notifications not allowed")
    }

    /** A server came up: it gets the handle, or the first one starts the asking. */
    private fun connected(server: String) {
        if (!enabled || !available) return
        val h = handle
        if (h != null) give(h, server) else ask()
    }

    private fun give(handle: String, server: String) {
        store.scope.launch {
            runCatching {
                store.call(server, "push_register", jsonOf("handle" to handle, "tag" to server, "off" to off))
            }.onFailure { Log.e(TAG, "push_register on ${store.name(server)} failed: ${it.message}") }
        }
    }

    /** A kind's switch moved: every server up now hears the new list. */
    fun setKind(kind: String, on: Boolean) {
        prefs.edit().putBoolean(key(kind), on).apply()
        val h = handle ?: return
        if (enabled) for (s in store.servers) if (store.serverState[s.id] == ConnState.Connected) give(h, s.id)
    }

    /**
     * A server being removed stops alerting this phone. Its own socket and token, read now,
     * since the removal drops both from the store.
     */
    private fun leave(s: Server) {
        val h = handle ?: return
        val token = store.token(s.id) ?: return
        store.scope.launch { runCatching { oneShot(s, token, "push_unregister", jsonOf("handle" to h)) } }
    }

    /** FCM handed a token, at launch or on a new one: trade it for a handle and give it to every server up now. */
    suspend fun registered(token: String) {
        // A first launch hears the token twice, from `onNewToken` and from asking: one seal is enough.
        if (!enabled || token == sealing) return
        sealing = token
        val body = jsonOf("platform" to "android", "token" to token).toString()
            .toRequestBody("application/json".toMediaType())
        val sealed = withContext(Dispatchers.IO) {
            runCatching {
                http.newCall(Request.Builder().url("$relay/api/push/register").post(body).build()).execute().use { r ->
                    if (!r.isSuccessful) throw DrayError("the relay answered ${r.code}")
                    wireJson.parseToJsonElement(r.body?.string().orEmpty())["handle"].str
                }
            }.onFailure { Log.e(TAG, "the relay at $relay sealed no handle: ${it.message}") }.getOrNull()
        } ?: return run { sealing = null }
        Log.i(TAG, "sealed a handle; handing it to the servers up now")
        handle = sealed
        for (s in store.servers) if (store.serverState[s.id] == ConnState.Connected) give(sealed, s.id)
    }

    /**
     * Settings' switch. Off takes the handle back from every server up now and drops the token,
     * so a server reached later hears 410 from the relay and forgets it too.
     */
    fun set(on: Boolean) {
        prefs.edit().putBoolean(ALLOW_KEY, on).apply()
        enabled = on
        if (on) return ask()
        val h = handle
        if (h != null) for (s in store.servers) if (store.serverState[s.id] == ConnState.Connected) {
            store.scope.launch { runCatching { store.call(s.id, "push_unregister", jsonOf("handle" to h)) } }
        }
        handle = null
        if (available) FirebaseMessaging.getInstance().deleteToken()
    }

    /**
     * Calls `cmd` on `server` for an alert's button. The store's socket where it is up; otherwise one
     * of its own, since a process FCM or a button just woke has nothing connected yet. A relayed
     * machine is listed only once its server says so, a moment after launch.
     */
    suspend fun answer(server: String, cmd: String, args: JsonObject) {
        var found: Server? = null
        for (i in 0 until 20) {
            found = store.servers.firstOrNull { it.id == server }
            if (found != null) break
            kotlinx.coroutines.delay(250)
        }
        val s = found ?: throw DrayError("this server is no longer paired")
        if (store.serverState[s.id] == ConnState.Connected) {
            store.call(s.id, cmd, args, timeoutMs = 15_000)
            return
        }
        oneShot(s, store.token(s.id) ?: "", cmd, args)
    }

    private suspend fun oneShot(s: Server, token: String, cmd: String, args: JsonObject): JsonElement {
        val state = MutableStateFlow<ConnState?>(null)
        val c = Connection(s.id, s.url, token, store.scope) { true }
        c.via = s.via?.machine
        c.onState = { state.value = it }
        try {
            c.resume()
            val up = withTimeout(15_000) { state.first { it == ConnState.Connected || it is ConnState.Waiting || it is ConnState.Failed } }
            if (up != ConnState.Connected) throw DrayError("can't reach the server")
            return c.call(cmd, args, timeoutMs = 15_000).ok
        } finally {
            c.stop()
        }
    }

    const val TAG = "DrayPush"
}
