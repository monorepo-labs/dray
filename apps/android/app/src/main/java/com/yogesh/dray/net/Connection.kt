package com.yogesh.dray.net

import com.yogesh.dray.wire.DrayError
import com.yogesh.dray.wire.SERVE_PROTOCOL
import com.yogesh.dray.wire.Welcome
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.int
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.message
import com.yogesh.dray.wire.str
import com.yogesh.dray.wire.wireJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/** One HTTP client for every socket and file read, so connections and their pools are shared. */
val http: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(12, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.SECONDS)
    // No pingInterval: each Connection probes its own socket, since a relay answers pings for the machine behind it.
    .build()

/** Why a server is not connected, in the terms its cure needs. */
sealed interface Problem {
    data object Offline : Problem
    data class Unreachable(val reason: String) : Problem
    /** The token was refused, or none is saved. */
    data object Auth : Problem
    data object ServerOlder : Problem
    data object ServerNewer : Problem
    data object BadAddress : Problem
    data class Other(val reason: String) : Problem

    /** Whether trying again later could help, which decides waiting against stopping. */
    val retries: Boolean get() = this is Offline || this is Unreachable || this is Other

    companion object {
        /** `judge_hello`'s refusals are sentences; the version one names which side to update. */
        fun of(error: Throwable, online: Boolean): Problem {
            if (error is DrayError) {
                val m = error.message ?: ""
                return when {
                    m == "wrong token" -> Auth
                    m.contains("serve protocol") -> if (m.contains("update the Dray app")) ServerNewer else ServerOlder
                    else -> Other(m)
                }
            }
            return if (!online) Offline else Unreachable(error.message ?: "Unreachable")
        }
    }
}

sealed interface ConnState {
    /** `attempt` counts tries since the last good connection; past zero it is a reconnect. */
    data class Connecting(val attempt: Int) : ConnState
    data object Connected : ConnState
    /** Backing off, and trying again at `until` (epoch ms) on its own. */
    data class Waiting(val problem: Problem, val until: Long) : ConnState
    /** Stopped: waiting cannot fix a refused token or a version apart. Retry asks again. */
    data class Failed(val problem: Problem) : ConnState
}

/** A reply frame: its `ok` value and the frame whole, which the store files as a transcript's cache. */
class Reply(val ok: JsonElement, val raw: String, val err: JsonElement?)

/**
 * One WebSocket to one `dray-serve`, reconnecting on its own. Every field is touched on the
 * main thread; OkHttp's callbacks parse off it and hop over.
 */
class Connection(
    val serverId: String,
    url: String,
    token: String,
    private val scope: CoroutineScope,
    private val online: () -> Boolean,
) {
    var url: String = url
        private set
    var token: String = token
        private set
    /** A machine the server at `url` shares, by its id there: the socket and `/file` reach it through that server. */
    var via: String? = null
    var welcome: Welcome? = null
        private set
    var onEvent: (name: String, frame: JsonObject) -> Unit = { _, _ -> }
    var onState: (ConnState) -> Unit = {}

    var connected = false
        private set
    private var socket: WebSocket? = null
    /** Set by a problem that will not clear on its own, so coming back to the front does not ask again. */
    private var stopped = false
    private var attempt = 0
    private var generation = 0
    private var retry = 1.0
    private var nextId = 1
    private val waiting = mutableMapOf<Int, CompletableDeferred<Reply>>()
    /** Probes sent, the newest one answered, and the newest one a frame came in after. */
    private var pinged = 0
    private var ponged = 0
    private var framed = 0
    /** Each probe's call id, to its number. */
    private val probes = mutableMapOf<Int, Int>()

    /**
     * Reconnects unless already connected: on launch and whenever the app comes back to the front.
     * One that reads connected is probed: the server can have dropped it while the phone slept,
     * leaving this side open and silent, and the reconnect is what re-reads the index and every
     * open transcript.
     */
    fun resume() {
        if (connected) probe(5_000, frames = false) else if (!stopped) connect()
    }

    /** Connects now, whatever it was waiting on. */
    fun retryNow() {
        if (connected) probe(5_000, frames = false) else connect()
    }

    /** For a refused token: the next connect sends this one. */
    fun update(token: String) {
        this.token = token
        connect()
    }

    fun stop() {
        generation++
        socket?.cancel()
        socket = null
        drop("Disconnected")
    }

    private fun connect() {
        generation++
        val gen = generation
        socket?.cancel()
        drop("Reconnecting")
        stopped = false
        val address = socketUrl(url)
        if (address == null) {
            stopped = true
            onState(ConnState.Failed(Problem.BadAddress))
            return
        }
        onState(ConnState.Connecting(attempt))
        val request = Request.Builder().url(address).build()
        socket = http.newWebSocket(request, Listener(gen))
        // A host that drops packets would hold the handshake; past this the attempt counts as unreachable.
        scope.launch {
            delay(12_000)
            if (gen == generation && !connected) socket?.cancel()
        }
    }

    private inner class Listener(val gen: Int) : WebSocketListener() {
        private var welcomed = false

        override fun onOpen(webSocket: WebSocket, response: Response) {
            val hello = jsonOf("v" to SERVE_PROTOCOL, "token" to token, "via" to via)
            val fields = hello.filterValues { it != JsonNull }
            webSocket.send(JsonObject(fields).toString())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val frame = runCatching { wireJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
            scope.launch(Dispatchers.Main.immediate) {
                if (gen != generation) return@launch
                if (!welcomed) {
                    welcomed = true
                    frame["err"]?.let { return@launch failed(DrayError(it.message)) }
                    welcome = decodeOrNull<Welcome>(frame)
                    connected = true
                    retry = 1.0
                    attempt = 0
                    onState(ConnState.Connected)
                    keepAlive(gen)
                    return@launch
                }
                framed = pinged
                route(frame, text)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            scope.launch(Dispatchers.Main.immediate) {
                if (gen == generation) failed(Exception("Disconnected"))
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            scope.launch(Dispatchers.Main.immediate) { if (gen == generation) failed(t) }
        }
    }

    private fun failed(error: Throwable) {
        // A refusal arrives as a message and then a close; only the first may decide what comes next.
        val gen = ++generation
        socket?.cancel()
        drop(error.message ?: "Disconnected")
        val problem = Problem.of(error, online())
        if (!problem.retries) {
            stopped = true
            onState(ConnState.Failed(problem))
            return
        }
        val wait = retry
        retry = minOf(retry * 2, 30.0)
        attempt++
        onState(ConnState.Waiting(problem, System.currentTimeMillis() + (wait * 1000).toLong()))
        scope.launch {
            delay((wait * 1000).toLong())
            if (gen == generation) connect()
        }
    }

    /** Keeps a tunnel from idling the socket out, and finds a dead one. */
    private fun keepAlive(gen: Int) = scope.launch {
        while (gen == generation) {
            delay(25_000)
            if (gen == generation) probe(15_000, frames = true)
        }
    }

    /**
     * Asks for `live_state` and cancels the socket where no reply comes in time, which fails it and
     * reconnects. A socket whose far end is gone without a close fails nothing: its answers just
     * never come. A command rather than a WebSocket ping, which OkHttp cannot send on demand and a
     * relay answers itself for the machine behind it. `frames` lets any frame answer instead, for a
     * reply queued behind a long tail on a slow link; never back from the background, where frames
     * held while away arrive first.
     */
    private fun probe(withinMs: Long, frames: Boolean) {
        val ws = socket ?: return
        if (!connected) return
        val gen = generation
        val n = ++pinged
        val id = nextId++
        probes[id] = n
        // A refused send means the socket is already closing, and its failure reconnects.
        if (!ws.send(jsonOf("id" to id, "cmd" to "live_state", "args" to JsonObject(emptyMap())).toString())) return
        scope.launch {
            delay(withinMs)
            probes.remove(id)
            if (gen == generation && connected && maxOf(ponged, if (frames) framed else 0) < n) ws.cancel()
        }
    }

    private fun route(frame: JsonObject, raw: String) {
        val id = frame["id"].int
        // Any reply answers a probe, an error included: a server that does not know the command still heard it.
        id?.let(probes::remove)?.let { ponged = maxOf(ponged, it); return }
        if (id != null) {
            waiting.remove(id)?.complete(Reply(frame["ok"] ?: JsonNull, raw, frame["err"]))
            return
        }
        frame["event"].str?.let { onEvent(it, frame) }
    }

    /** Fails every call waiting on a socket that is gone, so nothing hangs. */
    private fun drop(reason: String) {
        connected = false
        probes.clear()
        val pending = waiting.values.toList()
        waiting.clear()
        pending.forEach { it.completeExceptionally(DrayError(reason)) }
    }

    /**
     * Calls a server command, with arguments named as the desktop's `invoke` names them.
     * `timeoutMs` is how long a silent socket may hold the call.
     */
    suspend fun call(cmd: String, args: JsonObject = JsonObject(emptyMap()), timeoutMs: Long = 60_000): Reply {
        val ws = socket
        if (!connected || ws == null) throw DrayError("Not connected")
        val id = nextId++
        val deferred = CompletableDeferred<Reply>()
        waiting[id] = deferred
        val frame = jsonOf("id" to id, "cmd" to cmd, "args" to args).toString()
        if (!ws.send(frame)) {
            waiting.remove(id)
            throw DrayError("Not connected")
        }
        val reply = withTimeoutOrNull(timeoutMs) { deferred.await() }
        if (reply == null) {
            waiting.remove(id)
            throw DrayError("The server took too long to answer $cmd")
        }
        reply.err?.let { throw DrayError(it.message) }
        return reply
    }

    /** The server's HTTP origin, for `/file`. */
    val httpBase: String? get() = socketUrl(url)?.let { httpOf(it) }
}

/** An address as a reader types it — `host:port`, `http(s)://`, `ws(s)://` — as the URL the socket opens. */
fun socketUrl(text: String): String? {
    val s = text.trim()
    val url = when {
        s.startsWith("http://") -> "ws://" + s.removePrefix("http://")
        s.startsWith("https://") -> "wss://" + s.removePrefix("https://")
        s.startsWith("ws://") || s.startsWith("wss://") -> s
        else -> "ws://$s"
    }
    return if (httpOf(url).toHttpUrlOrNull()?.host.isNullOrEmpty()) null else url
}

/** `ws` → `http`, `wss` → `https`, trailing slash dropped. */
fun httpOf(socket: String): String = when {
    socket.startsWith("wss://") -> "https://" + socket.removePrefix("wss://")
    socket.startsWith("ws://") -> "http://" + socket.removePrefix("ws://")
    else -> socket
}.trimEnd('/')

/** A connect line is `<address> <64-hex token>`, what `dray server tunnel on` prints. */
fun parseConnectLine(text: String): Pair<String, String>? {
    val parts = text.trim().split(Regex("\\s+"))
    if (parts.size != 2 || parts[1].length != 64 || !parts[1].all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return null
    return parts[0] to parts[1]
}

/** What a pairing QR carries: `dray://connect?url=…&token=…&name=…`. */
data class PairLink(val url: String, val token: String, val name: String?) {
    companion object {
        fun parse(text: String): PairLink? {
            val uri = runCatching { android.net.Uri.parse(text.trim()) }.getOrNull() ?: return null
            if (uri.scheme != "dray" || uri.host != "connect") return null
            val (url, token) = parseConnectLine("${uri.getQueryParameter("url") ?: ""} ${uri.getQueryParameter("token") ?: ""}") ?: return null
            return PairLink(url, token, uri.getQueryParameter("name")?.takeIf { it.isNotEmpty() })
        }
    }
}
