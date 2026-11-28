package com.yogesh.dray.store

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.yogesh.dray.model.Entry
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.ProjectKey
import com.yogesh.dray.model.Run
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.Stage
import com.yogesh.dray.model.Transcript
import com.yogesh.dray.model.pickMark
import com.yogesh.dray.model.sessionBranch
import com.yogesh.dray.model.stageRuns
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.net.Connection
import com.yogesh.dray.net.Network
import com.yogesh.dray.net.connectionFailure
import com.yogesh.dray.net.socketUrl
import com.yogesh.dray.wire.AgentEvent
import com.yogesh.dray.wire.BackgroundTask
import com.yogesh.dray.wire.Bot
import com.yogesh.dray.wire.DeletedEvent
import com.yogesh.dray.wire.DrayError
import com.yogesh.dray.wire.Payload
import com.yogesh.dray.wire.PrMark
import com.yogesh.dray.wire.Project
import com.yogesh.dray.wire.QueueChanged
import com.yogesh.dray.wire.Queued
import com.yogesh.dray.wire.ServingEvent
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.Sharing
import com.yogesh.dray.wire.Snapshot
import com.yogesh.dray.wire.StatusEvent
import com.yogesh.dray.wire.TitleEvent
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.sentFrom
import com.yogesh.dray.wire.wireJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.UUID

@Serializable
data class Server(
    val id: String,
    val name: String,
    val url: String,
    /** The phone's own switch: off, it neither connects nor shows the server's tasks. Never sent. */
    val on: Boolean = true,
    /** A machine reached through a paired server that shares its list (#847). Never saved. */
    @Transient val via: Via? = null,
)

/** A relayed server's way in: the paired server it goes through, whose token it uses, and its id there. */
data class Via(val parent: String, val machine: String) {
    val key: String get() = "$parent/$machine"
}

/** A relayed machine's id, the same on every launch so its transcripts survive a reconnect. */
private fun relayedId(parent: String, machine: String): String {
    val d = MessageDigest.getInstance("SHA-256").digest("$parent/$machine".toByteArray())
    val msb = d.take(8).fold(0L) { a, b -> (a shl 8) or (b.toLong() and 0xff) }
    val lsb = d.drop(8).take(8).fold(0L) { a, b -> (a shl 8) or (b.toLong() and 0xff) }
    return UUID(msb, lsb).toString().uppercase()
}

/**
 * What a server's welcome names it by, from the token the phone holds for it: `server_id` in
 * serve.rs and `serverId` in Store.swift, which must hash it the same way.
 */
fun serverId(token: String): String =
    MessageDigest.getInstance("SHA-256").digest("dray-server\u0000$token".toByteArray()).take(8).joinToString("") { "%02x".format(it) }

/** One address however it was typed: `http`, a missing scheme, case or a trailing slash. */
private fun address(url: String) = (socketUrl(url) ?: url).lowercase().trim('/')

/** One folder however it was written: a bot's path and its chat's cwd differ by a trailing slash at most. */
fun samePath(a: String, b: String) = a.trim('/') == b.trim('/')

/**
 * Every server's sessions, merged, and what the phone holds about each: the iOS app's
 * `Store`, ported. Everything here is touched on the main thread.
 */
class Store(private val context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val prefs = context.getSharedPreferences("store", Context.MODE_PRIVATE)
    private val secrets = Secrets(context)
    private val cache = Cache(File(context.cacheDir, "dray"))

    var servers by mutableStateOf(listOf<Server>())
        private set
    val serverState = mutableStateMapOf<String, ConnState>()
    var items by mutableStateOf(mapOf<SessionKey, SessionItem>())
        private set
    val transcripts = mutableStateMapOf<SessionKey, Transcript>()
    val asks = mutableStateMapOf<SessionKey, List<AgentEvent>>()
    val queued = mutableStateMapOf<SessionKey, List<Queued>>()
    /** Counts the phone's own sends per session: a send brings its chat back to the bottom. */
    val sends = mutableStateMapOf<SessionKey, Int>()
    /** Counts `session_changed` per session, so a send can tell whether the server already spoke for it. */
    private val announced = mutableMapOf<SessionKey, Int>()
    var projects by mutableStateOf(mapOf<String, List<Project>>())
        private set
    /** Each repo's PR marks by branch, as `pr_marks` last answered. */
    val marks = mutableStateMapOf<ProjectKey, Map<String, PrMark>>()
    /** Each session's unsent reply, kept across leaving the screen. */
    val drafts = mutableStateMapOf<SessionKey, String>()
    private var shownError by mutableStateOf<String?>(null)
    /** An action's failure, for the toast. One being offline explains is left out: the offline line says it already. */
    var lastError: String?
        get() = shownError
        set(value) {
            if (value == null || online || !connectionFailure(value)) shownError = value
        }
    /** False while the phone reaches no internet, captive portal included, which every server shares. */
    var online by mutableStateOf(true)
        private set
    private lateinit var network: Network
    /** A server that connected and then failed to read its sessions. */
    val loadErrors = mutableStateMapOf<String, String>()
    /** A transcript that could not be read with nothing of it held yet. */
    val transcriptErrors = mutableStateMapOf<SessionKey, String>()
    /** Transcripts a server read has landed for since launch. */
    var serverRead by mutableStateOf(setOf<SessionKey>())
        private set
    /** An older page that could not be read; the newer turns stay on screen. */
    val olderErrors = mutableStateMapOf<SessionKey, String>()
    var olderLoading by mutableStateOf(setOf<SessionKey>())
        private set
    val tasks = mutableStateMapOf<SessionKey, List<BackgroundTask>>()
    /** The ports a session serves where servers are all its background work is (`session_serving`). */
    val serving = mutableStateMapOf<SessionKey, List<Int>>()
    /** Each server's bots: their chats are theirs, never task rows. */
    var bots by mutableStateOf(mapOf<String, List<Bot>>())
        private set
    /** Servers whose index and bots were read this launch: before that, an empty list is one not read yet. */
    var listed by mutableStateOf(setOf<String>())
        private set
    var botsRead by mutableStateOf(setOf<String>())
        private set
    /** Servers whose list this launch drew from the cache before any read. */
    var cached by mutableStateOf(setOf<String>())
        private set
    /** Servers down long enough to say so, or refused outright. A quick drop says nothing. */
    var lost by mutableStateOf(setOf<String>())
        private set
    /** Calls whose last read failed: a cut row draws nothing of its own, so it says so instead. */
    var callErrors by mutableStateOf(mapOf<SessionKey, Set<String>>())
        private set
    /** A clone's latest progress line per server and repo, while Attach project waits on it. */
    val cloneProgress = mutableStateMapOf<String, Map<String, String>>()

    /** Bot chats' previews, stall cards and pending agent picks: StoreBots.kt. */
    val botState = BotState()

    /** The pull requests and issues pages' last reads, drawn at once when either opens. */
    val pulls by lazy { PullsModel(this, cache) }
    val issues by lazy { IssuesModel(this, cache) }

    /** A server came up: push hands it this phone's handle, and presence says again what is on screen. */
    val onConnected = mutableListOf<(String) -> Unit>()
    /** A server is about to be removed, while its token can still be read. */
    var onRemoving: (Server) -> Unit = {}

    private val connections = mutableMapOf<String, Connection>()
    private val statuses = mutableMapOf<SessionKey, StatusEvent>()
    private val marksAt = mutableMapOf<ProjectKey, Long>()
    private val marking = mutableSetOf<ProjectKey>()
    private val downSince = mutableMapOf<String, Long>()
    private val reading = mutableSetOf<String>()
    /** Transcripts opened while their server was down, read once it connects. */
    private val waiting = mutableSetOf<SessionKey>()
    private val callAsks = mutableMapOf<SessionKey, MutableSet<String>>()
    private val callBatch = mutableMapOf<SessionKey, MutableSet<String>>()
    private var listSaving = false

    /** What each paired server last shared, so a copy held back comes back without asking it again. */
    private val shared = mutableMapOf<String, List<Sharing.Machine>>()
    /** Each shared machine's `identity` by `Via.key`, kept across launches so a copy is held back before it ever connects. */
    private val copyIds = mutableStateMapOf<String, String>().apply {
        prefs.getString("copyIds", null)?.let { runCatching { putAll(wireJson.decodeFromString(copyIdsSerializer, it)) } }
    }
    /** Paired servers' `identity`, hashed from their tokens once. */
    private val directIds = mutableMapOf<String, String>()
    /** Paired servers down long enough to count as failing, which lets their copies back. Coming to the front clears `lost`, never this. */
    private val unreachable = mutableSetOf<String>()
    /** A held-back copy's id and the paired server shown in its place, both ways, so an alert tagged with either still lands. */
    private val standIns = mutableMapOf<String, String>()

    fun read(id: String) = id in listed && id in botsRead
    fun known(id: String) = id in cached || read(id)

    init {
        prefs.getString("servers", null)?.let { saved ->
            servers = runCatching { wireJson.decodeFromString(ListSerializer(Server.serializer()), saved) }.getOrDefault(emptyList())
        }
        for (s in servers) if (s.on) start(s)
        watchNetwork()
    }

    private fun watchNetwork() {
        network = Network(context, scope) { up, wake ->
            online = up
            if (!up && shownError?.let(::connectionFailure) == true) shownError = null
            // The network coming back retries every server at once, rather than each sitting out its backoff.
            if (wake) resume(now = true)
        }
        online = network.online
    }

    // Servers

    val live: List<Server> get() = covered.let { c -> servers.filter { it.on && it.id !in c } }

    /**
     * Paired servers shown through a sharing Mac instead, while they are unreachable themselves
     * (#1404): their own rows are the last read's, and would draw every session twice.
     */
    val covered: Set<String>
        get() {
            val shown = servers.mapNotNull { s -> s.via?.let { copyIds[it.key] } }.toSet()
            if (shown.isEmpty()) return emptySet()
            return servers.filter { it.via == null && directId(it.id) in shown }.map { it.id }.toSet()
        }

    /** The server an alert tagged `id` now goes to: a copy held back answers as its paired server, and back. */
    fun shownAs(id: String): String =
        if (servers.any { it.id == id }) id else standIns[id]?.takeIf { s -> servers.any { it.id == s } } ?: id

    private fun directId(id: String): String? = directIds[id] ?: secrets.get(id)?.let(::serverId)?.also { directIds[id] = it }

    /** The paired server a shared machine is held back for: on, not failing, and holding the token its welcome hashes. */
    private fun twin(via: Via): String? {
        val identity = copyIds[via.key] ?: return null
        return servers.firstOrNull { it.via == null && it.id != via.parent && it.on && it.id !in unreachable && directId(it.id) == identity }?.id
    }

    /** Brings every share back in line after a paired server came, went or changed state. */
    private fun reshare() {
        for ((parent, machines) in shared.toMap()) share(parent, machines)
    }

    private fun saveCopyIds() {
        prefs.edit().putString("copyIds", wireJson.encodeToString(copyIdsSerializer, copyIds.toMap())).apply()
    }

    fun connection(server: String): Connection? = connections[server]
    fun name(of: String): String = servers.firstOrNull { it.id == of }?.name ?: "Server"
    fun token(server: String): String? = secrets.get(servers.firstOrNull { it.id == server }?.via?.parent ?: server)

    /** The saved server this address or token names: a token is the server's own, so either matching is the same machine. */
    fun saved(url: String, token: String): Server? =
        servers.firstOrNull { it.via == null && (address(it.url) == address(url) || secrets.get(it.id) == token) }

    /** Adds a server, or where it is already saved, takes the new address and token and turns it on. */
    fun addServer(name: String, url: String, token: String) {
        val held = saved(url, token)
        if (held != null) {
            if (address(held.url) == address(url)) {
                if (secrets.get(held.id) != token) updateToken(held.id, token)
                return setServerOn(held.id, true)
            }
            // A tunnel that restarted keeps its token and moves: reconnect, same id, at the new address.
            drop(held.id)
            val moved = held.copy(url = url, on = true)
            servers = servers.map { if (it.id == held.id) moved else it }
            secrets.set(held.id, token)
            directIds.remove(held.id)
            save()
            start(moved)
            return reshare()
        }
        val s = Server(UUID.randomUUID().toString().uppercase(), name, url)
        secrets.set(s.id, token)
        servers = servers + s
        save()
        start(s)
        // Its copy through a Mac goes now, not once it connects: until it fails it is the way in.
        reshare()
    }

    fun removeServer(s: Server) {
        // A copy coming back in its place takes the push handle over on that same server; unregistering
        // would race its registering, and the server drops a handle whatever tag it was given under.
        val heldFor = shared.flatMap { (p, ms) -> ms.map { Via(p, it.id) } }.filter { twin(it) == s.id }
        if (heldFor.isEmpty()) onRemoving(s)
        for (gone in servers.filter { it.via?.parent == s.id }) onRemoving(gone)
        forget(s.id)
        secrets.delete(s.id)
        directIds.remove(s.id)
        if (copyIds.keys.removeAll { it.startsWith("${s.id}/") }) saveCopyIds()
        heldFor.firstOrNull()?.let { standIns[s.id] = relayedId(it.parent, it.machine) }
        save()
        // Only copies held back for this server come back: twin() asks each who it is held for.
        reshare()
    }

    fun renameServer(id: String, name: String) {
        servers = servers.map { if (it.id == id) it.copy(name = name) else it }
        save()
    }

    /** Off drops the connection and all held of it; on connects afresh and reads everything again. */
    fun setServerOn(id: String, on: Boolean) {
        val s = servers.firstOrNull { it.id == id } ?: return
        if (s.on == on) return
        val next = s.copy(on = on)
        servers = servers.map { if (it.id == id) next else it }
        save()
        if (on) start(next) else drop(id)
        reshare()
    }

    /** A new token for a server whose old one was refused, tried at once. */
    fun updateToken(id: String, token: String) {
        secrets.set(id, token)
        directIds.remove(id)
        connections[id]?.update(token)
        for (s in servers) if (s.via?.parent == id) connections[s.id]?.update(token)
        reshare()
    }

    private fun save() {
        prefs.edit().putString("servers", wireJson.encodeToString(ListSerializer(Server.serializer()), servers.filter { it.via == null })).apply()
    }

    private fun forget(id: String) {
        val gone = setOf(id) + servers.filter { it.via?.parent == id }.map { it.id }
        drop(id)
        transcripts.keys.filter { it.server in gone }.forEach { transcripts.remove(it) }
        servers = servers.filter { it.id != id }
        gone.forEach { cache.forget(it) }
    }

    /** Transcripts stay: a session left open across off and on is reloaded by `connected`. */
    private fun drop(id: String) {
        for (s in servers.filter { it.via?.parent == id }) {
            drop(s.id)
            servers = servers.filter { it.id != s.id }
        }
        connections.remove(id)?.stop()
        serverState.remove(id)
        items = items.filterKeys { it.server != id }
        asks.keys.filter { it.server == id }.forEach { asks.remove(it) }
        marks.keys.filter { it.server == id }.forEach { marks.remove(it) }
        marksAt.keys.removeAll { it.server == id }
        tasks.keys.filter { it.server == id }.forEach { tasks.remove(it) }
        serving.keys.filter { it.server == id }.forEach { serving.remove(it) }
        queued.keys.filter { it.server == id }.forEach { queued.remove(it) }
        projects = projects - id
        bots = bots - id
        loadErrors.remove(id)
        listed = listed - id
        botsRead = botsRead - id
        cached = cached - id
        lost = lost - id
        downSince.remove(id)
        unreachable.remove(id)
        shared.remove(id)
    }

    /**
     * Coming back to the front reconnects, and probes a socket still reading connected, which may be
     * dead without knowing it. `now` also asks servers that stopped, as a Retry does.
     */
    fun resume(now: Boolean = false) {
        for ((id, state) in serverState.toMap()) {
            if (state == ConnState.Connected || state is ConnState.Failed) continue
            lost = lost - id
            downSince.remove(id)
            track(id, state)
        }
        for (c in connections.values) if (now) c.retryNow() else c.resume()
    }

    private fun track(id: String, state: ConnState) {
        when (state) {
            ConnState.Connected -> {
                downSince.remove(id)
                lost = lost - id
                if (unreachable.remove(id)) reshare()
            }
            // Waiting cannot fix a refused token or a version apart.
            is ConnState.Failed -> failing(id)
            else -> {
                if (downSince[id] != null) return
                val since = System.currentTimeMillis()
                downSince[id] = since
                scope.launch {
                    delay(LOST_AFTER_MS)
                    if (downSince[id] == since) failing(id)
                }
            }
        }
    }

    /** Down long enough to say so: a paired server's copy through a Mac comes back in its place. */
    private fun failing(id: String) {
        lost = lost + id
        if (servers.any { it.id == id && it.via == null } && unreachable.add(id)) reshare()
    }

    /** One server's Retry: reconnect where it is down, re-read where it is up. */
    fun retry(server: String) {
        if (serverState[server] == ConnState.Connected) scope.launch { loadIndex(server) } else connections[server]?.retryNow()
    }

    suspend fun refresh() {
        for (s in servers.filter { serverState[it.id] == ConnState.Connected }) {
            loadShared(s.id)
            loadIndex(s.id)
            loadProjects(s.id)
            loadMarks(s.id, force = true)
        }
    }

    /** A command on one server, for a screen reading what the store does not hold. */
    suspend fun call(server: String, cmd: String, args: JsonObject = JsonObject(emptyMap()), timeoutMs: Long = 60_000): JsonElement {
        val c = connections[server] ?: throw DrayError("Not connected")
        return c.call(cmd, args, timeoutMs).ok
    }

    private fun start(s: Server) {
        // No token saved connects anyway: the server refuses it, which draws as a refused token.
        val token = secrets.get(s.via?.parent ?: s.id) ?: ""
        val c = Connection(s.id, s.url, token, scope) { online }
        c.via = s.via?.machine
        c.onState = { state ->
            serverState[s.id] = state
            track(s.id, state)
            // A server that stopped answering may be this phone's network, not the server.
            if (state is ConnState.Waiting && ::network.isInitialized) network.suspect()
            if (state == ConnState.Connected) scope.launch { connected(s.id) }
        }
        c.onEvent = { name, frame -> handle(s.id, name, frame) }
        connections[s.id] = c
        restoreList(s.id)
        c.resume()
    }

    /**
     * Brings `parent`'s relayed servers in line with what it shares, bar a machine the phone also
     * pairs directly (#1404): that copy is held back while the direct way works, which it does
     * with the Mac off too.
     */
    private fun share(parent: String, machines: List<Sharing.Machine>) {
        val p = servers.firstOrNull { it.id == parent && it.via == null } ?: return
        shared[parent] = machines
        for (s in servers.filter { it.via?.parent == parent }) {
            val via = s.via ?: continue
            if (machines.none { it.id == via.machine }) forget(s.id) else twin(via)?.let { hold(s, it) }
        }
        for (m in machines) {
            val id = relayedId(parent, m.id)
            val twin = twin(Via(parent, m.id))
            if (twin != null) {
                standIns[id] = twin
                continue
            }
            if (servers.any { it.id == id }) {
                servers = servers.map { if (it.id == id) it.copy(name = m.name) else it }
                continue
            }
            val s = Server(id, m.name, p.url, via = Via(parent, m.id))
            // Listed under the server it goes through.
            val after = servers.indexOfLast { it.id == parent || it.via?.parent == parent }
            servers = servers.toMutableList().apply { add(after + 1, s) }
            start(s)
        }
    }

    /**
     * Takes a copy off the list for `twin`. A copy that connected handed the phone's push handle
     * to that same server under its own tag, and the server keeps one tag per handle, so the twin
     * takes it back rather than the copy unregistering, which would drop the twin's too.
     */
    private fun hold(s: Server, twin: String) {
        val wasUp = serverState[s.id] == ConnState.Connected
        forget(s.id)
        standIns[s.id] = twin
        standIns.remove(twin)
        if (wasUp && serverState[twin] == ConnState.Connected) onConnected.forEach { it(twin) }
    }

    private suspend fun loadShared(server: String) {
        if (servers.firstOrNull { it.id == server }?.via != null) return
        // A server from before sharing answers `unknown command`, and shares nothing.
        val sharing = runCatching { decodeOrNull<Sharing>(call(server, "share_machines")) }.getOrNull()
        if (sharing != null) share(server, sharing.machines)
    }

    // Cache

    /** What the list last held of a server, so a cold open draws it before any socket is up. */
    private fun restoreList(id: String) {
        if (items.keys.any { it.server == id }) return
        val held = cache.readList(id) ?: return
        items = items + held.items.associateBy { SessionKey(id, it.sessionId) }
        projects = projects + (id to held.projects)
        bots = bots + (id to held.bots)
        cached = cached + id
    }

    /** Writes every live server's list a moment after the last change, off the main thread. */
    private fun keepList() {
        if (listSaving) return
        listSaving = true
        scope.launch {
            delay(2000)
            listSaving = false
            for (s in live) {
                // Only what both reads answered: a launch trusts this file to say which rows are bots.
                if (!read(s.id)) continue
                val held = CachedList(
                    items.filter { it.key.server == s.id && it.value.archived != true }.values.toList(),
                    projects[s.id].orEmpty(), bots[s.id].orEmpty(),
                )
                withContext(Dispatchers.IO) { cache.writeList(s.id, held) }
            }
        }
    }

    private fun putItems(next: Map<SessionKey, SessionItem>) {
        items = next
        keepList()
    }

    internal fun setItem(key: SessionKey, item: SessionItem?) {
        putItems(if (item == null) items - key else items + (key to item))
    }

    /** A session this phone started, put in the list before its `session_created` lands. */
    fun created(server: String, item: SessionItem) {
        setItem(SessionKey(server, item.sessionId), item)
        scope.launch { loadMarks(server, force = false, only = setOf(item.projectPath)) }
    }

    /** The project list an attach or clone answered with. */
    fun attached(server: String, list: List<Project>) {
        projects = projects + (server to list)
        keepList()
    }

    /** A fresh connection re-reads the index and the tail of every open transcript, so nothing missed while down is lost. */
    private suspend fun connected(server: String) {
        // A copy names who it is only here, the first time; learnt, it may be one to hold back before anything of it is read.
        servers.firstOrNull { it.id == server }?.via?.let { via ->
            val identity = connections[server]?.welcome?.identity
            if (identity != null && copyIds[via.key] != identity) {
                copyIds[via.key] = identity
                saveCopyIds()
                reshare()
            }
        }
        if (servers.none { it.id == server }) return
        scope.launch { loadBots(server) }
        scope.launch { loadShared(server) }
        onConnected.forEach { it(server) }
        // Heard on the old socket, so older than the read below; a read never moves `modified`, so a stale `completed` would win.
        statuses.keys.removeAll { it.server == server }
        loadIndex(server)
        val opened = waiting.filter { it.server == server }
        waiting.removeAll(opened.toSet())
        for (key in (transcripts.keys + transcriptErrors.keys + opened).toSet()) if (key.server == server) reload(key)
        // After the transcripts: a mark costs a `gh` call per repo, missed messages must not wait on it.
        loadProjects(server)
        loadMarks(server, force = false)
    }

    internal suspend fun loadBots(server: String) {
        // A server from before bots answers `unknown command`, and holds none.
        val list = runCatching { decodeList<Bot>(call(server, "list_bots")) }.getOrNull()
        botsRead = botsRead + server
        if (list != null) {
            bots = bots + (server to list)
            keepList()
            loadPreviews(server)
        }
    }

    /** The bot whose chat this session is: one running in its folder. */
    fun bot(key: SessionKey): Bot? {
        val cwd = items[key]?.cwd ?: return null
        return bots[key.server]?.firstOrNull { samePath(it.path, cwd) }
    }

    private suspend fun loadProjects(server: String) {
        runCatching { decodeList<Project>(call(server, "list_projects")) }.getOrNull()?.let {
            projects = projects + (server to it)
            keepList()
        }
    }

    // PR marks

    private fun repos(server: String): Set<String> =
        items.filter { it.key.server == server && it.value.hidden != true && it.value.archived != true }.values.map { it.projectPath }.toSet()

    /** One `pr_marks` per repo, fresh for two minutes unless forced. A failed read leaves the last good marks. */
    internal suspend fun loadMarks(server: String, force: Boolean, only: Set<String>? = null) {
        if (connections[server] == null) return
        for (path in only ?: repos(server)) {
            val key = ProjectKey(server, path)
            if (key in marking) continue
            if (!force && (marksAt[key]?.let { System.currentTimeMillis() - it < 120_000 } == true)) continue
            marking += key
            try {
                val list = runCatching { decodeList<PrMark>(call(server, "pr_marks", jsonOf("cwd" to path))) }.getOrNull() ?: continue
                marks[key] = list.groupBy { it.headRefName }.mapNotNull { (b, prs) -> pickMark(prs)?.let { b to it } }.toMap()
                marksAt[key] = System.currentTimeMillis()
            } finally {
                marking -= key
            }
        }
    }

    /** One repo's marks read again now, after an action moved its PR. */
    suspend fun refreshMarks(server: String, path: String) = loadMarks(server, force = true, only = setOf(path))

    /** Re-reads every repo holding an open PR — the only mark that moves on its own. Every 30s while on screen. */
    suspend fun pollMarks() {
        for (s in servers.filter { serverState[it.id] == ConnState.Connected }) {
            val now = System.currentTimeMillis()
            val open = marks.keys.filter { k ->
                k.server == s.id && marks[k]?.values?.any { it.state == "OPEN" } == true && now - (marksAt[k] ?: 0) >= 30_000
            }.map { it.path }.toSet()
            if (open.isNotEmpty()) loadMarks(s.id, force = true, only = open)
        }
    }

    fun prMark(key: SessionKey, item: SessionItem): PrMark? =
        // The sidebar's guess: no observed HEAD, which would cost a spawn per row.
        sessionBranch(item.branch, item.worktreeName, item.worktreeRemoved ?: false, null)
            ?.let { marks[ProjectKey(key.server, item.projectPath)]?.get(it) }

    private suspend fun loadIndex(server: String) {
        try {
            val list = decodeList<SessionItem>(call(server, "list_session_index_items", jsonOf("archived" to false)))
            // Settled rows are the settled view's to replace; built apart and written once, so the list redraws once.
            val next = items.filter { it.key.server != server || it.value.archived == true }.toMutableMap()
            for (item in list) {
                val key = SessionKey(server, item.sessionId)
                next[key] = merged(key, item)
            }
            putItems(next)
            loadErrors.remove(server)
            listed = listed + server
        } catch (e: Exception) {
            // The rows already listed stay; the list says this read failed beside them.
            loadErrors[server] = e.message ?: "Couldn't read sessions"
        }
    }

    /** Settled sessions, read only when the settled view asks: the live read leaves them out. */
    suspend fun loadSettled() {
        var failed: String? = null
        for (s in servers.filter { serverState[it.id] == ConnState.Connected }) {
            val held = items.filter { it.key.server == s.id && it.value.archived == true }.mapValues { it.value.modified }
            val read = runCatching { decodeList<SessionItem>(call(s.id, "list_session_index_items", jsonOf("archived" to true))) }
            val list = read.getOrNull() ?: run {
                failed = read.exceptionOrNull()?.message ?: "The server didn't answer."
                null
            } ?: continue
            val listedIds = list.map { it.sessionId }.toSet()
            val next = items.toMutableMap()
            // A row the reply leaves out was deleted, unless an event moved it meanwhile.
            for ((key, modified) in held) if (key.id !in listedIds) {
                val now = next[key]
                if (now != null && now.archived == true && now.modified == modified) next.remove(key)
            }
            for (item in list) next[SessionKey(s.id, item.sessionId)] = merged(SessionKey(s.id, item.sessionId), item)
            putItems(next)
        }
        settledError = failed
    }

    /** Why the last settled read failed on a server, so the settled view offers Retry rather than "Nothing settled." */
    /** Moves when any client saves a draft or this one drops one: the drafts view reads again. */
    var draftsRevision by mutableIntStateOf(0)
    /** Per server, moves on each `secrets_changed`. */
    val secretsRevision = mutableStateMapOf<String, Int>()

    var settledError by mutableStateOf<String?>(null)
        private set

    /** A status event that arrived while a read was out is newer than the read, so it wins. */
    internal fun merged(key: SessionKey, read: SessionItem): SessionItem {
        dropStalePick(key, read)
        val s = statuses[key] ?: return read
        val m = s.modified ?: return read
        return if (m >= read.modified) read.copy(status = s.status, modified = m) else read
    }

    // Sessions

    /**
     * What the list draws, in the desktop sidebar's runs: the live sessions or the settled ones,
     * narrowed to one project by name — by name, so a repo on two machines is one project.
     */
    fun runs(project: String?, settled: Boolean = false): List<Run> {
        val chats = bots.mapValues { (_, list) -> list.map { it.path } }
        val hidden = covered
        val list = items.filter { (key, item) ->
            key.server !in hidden && item.hidden != true && (item.archived == true) == settled &&
                (project == null || project == item.project) &&
                // A bot's chat is its row in the bots section, never a task row.
                !(!settled && chats[key.server].orEmpty().any { samePath(it, item.cwd) }) &&
                // The index lands before the bots, and a bot's chat would draw as a task row until they do.
                (settled || known(key.server))
        }.map { Entry(it.key, it.value) }
        return stageRuns(list, pins = !settled) { stage(it.key, it.item) }
    }

    /** The desktop's `sessionState`: a merged PR holds its session whatever the turn says. */
    private fun stage(key: SessionKey, item: SessionItem): Stage {
        if (isAsking(key)) return Stage.Asking
        val mark = prMark(key, item)
        val open = if (mark?.state == "OPEN") mark else null
        if (open == null && mark?.state == "MERGED") return Stage.Merged
        if (item.status == "completed") return if (open == null) Stage.Completed else Stage.UnreadPr
        if (open == null) return Stage.Idle
        return if (open.checksState == "RUNNING") Stage.Checks else Stage.Pr
    }

    fun isAsking(key: SessionKey) = !asks[key].isNullOrEmpty()

    /** Background work the agent waits on: tasks, unless they are only a server left up for the reader. */
    fun inBackground(key: SessionKey) = !tasks[key].isNullOrEmpty() && serving[key].isNullOrEmpty()

    suspend fun open(key: SessionKey) {
        load(key)
        val item = items[key]
        if (item?.status == "completed") {
            setItem(key, item.copy(status = "idle"))
            runCatching { call(key.server, "mark_session_read", jsonOf("sessionId" to key.id, "read" to true)) }
        }
    }

    /** Starts following a transcript: what was read last time draws at once, and the read lays the newest turns over it. */
    suspend fun load(key: SessionKey) {
        if (transcripts[key] != null) return
        val held = withContext(Dispatchers.IO) { cache.readTranscript(key)?.let { Snapshot.decode(it) } }
        if (held != null && transcripts[key] == null) transcripts[key] = Transcript.of(held.events, held.olderBefore)
        // Down, the connect reads it: a read now only fails.
        if (serverState[key.server] != ConnState.Connected) {
            waiting += key
            return
        }
        // In the store's scope, one per chat: a screen that leaves cancels only its wait, never the
        // read, which a later open would skip since the held copy already stands in for it.
        val read = firstReads[key] ?: scope.launch(start = CoroutineStart.LAZY) {
            try { reload(key) } finally { firstReads.remove(key) }
        }.also { firstReads[key] = it; it.start() }
        read.join()
    }

    private val firstReads = mutableMapOf<SessionKey, Job>()

    fun isLoading(key: SessionKey) = transcripts[key] == null && transcriptErrors[key] == null

    /** A chat's first read since launch is out: said once per chat, later opens read quietly. */
    fun checking(key: SessionKey) = key !in serverRead && transcriptErrors[key] == null && serverState[key.server] == ConnState.Connected

    fun retryLoad(key: SessionKey) {
        if (serverState[key.server] == ConnState.Connected) scope.launch { reload(key) } else connections[key.server]?.retryNow()
    }

    /**
     * Re-reads the newest turns and lays them over what is held: older pages the read starts
     * inside are kept, the read's own events follow in log order, and anything that arrived live
     * while it was out goes last. A held event keeps its held copy, since a call a row read whole
     * stays whole under the cut copy the read brings.
     */
    private suspend fun reload(key: SessionKey) {
        val c = connections[key.server] ?: return
        val before = transcripts[key]?.ids.orEmpty()
        try {
            val reply = c.call("get_session_by_id", readArgs(key, jsonOf("sessionId" to key.id, "turns" to 8)))
            val snap = withContext(Dispatchers.Default) { Snapshot.decode(reply.ok) }
            if (snap != null) {
                val raw = reply.ok.toString()
                scope.launch(Dispatchers.IO) { cache.writeTranscript(key, raw) }
            } else {
                // Deleted from another client. Said, or the transcript waits on a read that already answered.
                transcriptErrors[key] = "Session not found."
                return
            }
            val readIds = snap.events.map { it.id }.toSet()
            val held = transcripts[key]?.events.orEmpty()
            val heldById = held.associateBy { it.id }
            val live = held.filter { it.id !in before && it.id !in readIds }
            val first = snap.events.firstOrNull()
            val i = first?.let { f -> held.indexOfFirst { it.id == f.id } } ?: -1
            val older = if (i > 0) held.subList(0, i) else emptyList()
            val olderBefore = if (i >= 0) transcripts[key]?.olderBefore else snap.olderBefore
            transcripts[key] = Transcript.of(older + snap.events.map { heldById[it.id] ?: it } + live, olderBefore)
            transcriptErrors.remove(key)
            serverRead = serverRead + key
        } catch (e: CancellationException) {
            // The screen that asked went away or restarted its effect (an unread chat's open marks it
            // read, which restarts the status-keyed one): nothing failed, and the next read answers.
            throw e
        } catch (e: Exception) {
            transcriptErrors[key] = e.message ?: "Couldn't load"
        }
    }

    /**
     * How a transcript is asked for, the desktop's `readAs`: a bot's chat as the conversation alone,
     * anything else over a network with its tool bodies cut, which a row reads by its call.
     */
    private fun readArgs(key: SessionKey, args: JsonObject): JsonObject =
        JsonObject(args + if (bot(key) != null) mapOf("bot" to JsonPrimitive(true)) else mapOf("lite" to JsonPrimitive(true)))

    fun callFailed(key: SessionKey, callId: String) = callErrors[key]?.contains(callId) == true

    /** Reads one tool call's whole events for a row whose body a `lite` read cut. Asks within a frame go out as one read. */
    fun completeCall(key: SessionKey, callId: String) {
        if (callAsks[key]?.contains(callId) == true) return
        callAsks.getOrPut(key) { mutableSetOf() } += callId
        val first = callBatch.isEmpty()
        callBatch.getOrPut(key) { mutableSetOf() } += callId
        if (!first) return
        scope.launch {
            delay(16)
            val batch = callBatch.toMap()
            callBatch.clear()
            for ((k, ids) in batch) scope.launch { readCalls(k, ids.toSet()) }
        }
    }

    private suspend fun readCalls(key: SessionKey, ids: Set<String>) {
        try {
            val whole = AgentEvent.list(call(key.server, "get_session_calls", jsonOf("sessionId" to key.id, "callIds" to ids.toList())))
            callErrors = callErrors + (key to (callErrors[key].orEmpty() - ids))
            val byId = whole.associateBy { it.id }
            val t = transcripts[key] ?: return
            if (byId.isEmpty()) return
            transcripts[key] = t.copy(events = t.events.map { byId[it.id] ?: it })
        } catch (e: Exception) {
            callErrors = callErrors + (key to (callErrors[key].orEmpty() + ids))
        } finally {
            callAsks[key]?.removeAll(ids)
        }
    }

    fun loadOlder(key: SessionKey) {
        val c = connections[key.server] ?: return
        val before = transcripts[key]?.olderBefore ?: return
        if (key in olderLoading) return
        olderLoading = olderLoading + key
        olderErrors.remove(key)
        scope.launch {
            try {
                val reply = c.call("get_session_page", readArgs(key, jsonOf("sessionId" to key.id, "before" to before, "turns" to 16)))
                val page = withContext(Dispatchers.Default) { Snapshot.decode(reply.ok) } ?: throw DrayError("Session not found.")
                val t = transcripts[key] ?: return@launch
                val older = page.events.filter { it.id !in t.ids }
                transcripts[key] = Transcript(older + t.events, t.ids + older.map { it.id }, page.olderBefore)
            } catch (e: Exception) {
                olderErrors[key] = e.message ?: "Couldn't load"
            } finally {
                olderLoading = olderLoading - key
            }
        }
    }

    /**
     * Sends a reply carrying the session's own recorded settings back, so `send_msg` finds nothing
     * changed and respawns nothing. They are read fresh first: another client moving the model
     * broadcasts nothing, and a held copy sent back would undo its change. Each pick that is null
     * keeps the session's as just re-read. Another `harness` moves the task there first (#1417).
     */
    suspend fun send(
        key: SessionKey, text: String, model: String? = null, effort: String? = null,
        stance: String? = null, fast: Boolean? = null, effortMoved: Boolean = false, harness: String? = null,
    ): Boolean {
        val c = connections[key.server] ?: return false.also { lastError = "Not connected" }
        return try {
            var item = decodeOrNull<SessionItem>(c.call("get_session_by_id", jsonOf("sessionId" to key.id, "turns" to 0)).ok)
                ?: throw DrayError("Session not found")
            setItem(key, merged(key, item))
            if (harness != null && harness != item.harness) {
                switchAgent(c, key, merged(key, item), harness, model ?: item.model, effort, stance, fast)
                item = item.copy(harness = harness)
            }
            val heard = announced[key]
            val sent = item.copy(
                model = model ?: item.model,
                effort = if (effortMoved) effort else effort ?: item.effort,
                permissionMode = Picks.taskStance(item.harness, stance ?: item.permissionMode),
                fast = fast ?: item.fast ?: false,
            )
            val reply = c.call(
                "send_msg",
                jsonOf(
                    "sessionId" to key.id,
                    "prompt" to text,
                    "attachmentPaths" to emptyList<String>(),
                    "harness" to sent.harness,
                    "model" to sent.model,
                    "effort" to sent.effort,
                    "permissionMode" to sent.permissionMode,
                    "fast" to sent.fast,
                    "cwd" to item.cwd,
                    "branch" to null,
                    "useWorktree" to false,
                    "worktreeName" to null,
                    "baseRef" to null,
                    "isNewSession" to false,
                    *sentFrom(),
                ),
            ).ok
            decodeOrNull<SessionItem>(reply["snapshot"])?.let { setItem(SessionKey(key.server, it.sessionId), it) }
            // What `send_msg` wrote to the index, for a server too old to say so in `session_changed`:
            // without it the dock falls back to the model the session just left. A newer server's word
            // wins, since it may have refused a pick. An unset model keeps the old.
            if (announced[key] == heard) items[key]?.let {
                setItem(key, it.copy(model = sent.model.ifEmpty { it.model }, effort = sent.effort, permissionMode = sent.permissionMode, fast = sent.fast))
            }
            // By id: the server's `queue_changed` usually lands before this reply.
            decodeOrNull<Queued>(reply["queued"])?.let { q ->
                if (queued[key]?.contains(q) != true) queued[key] = queued[key].orEmpty() + q
            }
            sends[key] = (sends[key] ?: 0) + 1
            true
        } catch (e: Exception) {
            lastError = e.message
            false
        }
    }

    /**
     * Moves a task to `harness` ahead of the send that picked it. Its own command, so a server from
     * before #1417 refuses it and nothing is sent, rather than the old agent answering.
     */
    private suspend fun switchAgent(
        c: Connection, key: SessionKey, item: SessionItem, harness: String, model: String, effort: String?, stance: String?, fast: Boolean?,
    ) {
        val name = Picks.agentLabels[harness] ?: harness
        // The switch stops the agent, which would cut its turn off.
        if (item.busy) throw DrayError("Wait for this turn to finish before switching to $name.")
        try {
            c.call(
                "switch_agent",
                jsonOf(
                    "sessionId" to key.id, "harness" to harness, "model" to model, "effort" to effort,
                    "permissionMode" to Picks.taskStance(harness, stance ?: item.permissionMode), "fast" to (fast ?: item.fast ?: false),
                ),
            )
        } catch (e: DrayError) {
            throw if (e.message.orEmpty().contains("unknown command")) DrayError("Update this server to switch a task to $name.") else e
        }
        botState.unsent.remove(key)
    }

    /** The reader's emoji on a bot's message `messageId`. The badge and the bot's answer come back as events. */
    fun react(key: SessionKey, messageId: String, emoji: String) = scope.launch {
        runCatching { call(key.server, "react_to_message", jsonOf("sessionId" to key.id, "messageId" to messageId, "emoji" to emoji)) }
            .onFailure { lastError = it.message }
    }

    fun interrupt(key: SessionKey) = scope.launch {
        runCatching { call(key.server, "interrupt_session", jsonOf("sessionId" to key.id)) }.onFailure { lastError = it.message }
    }

    suspend fun respond(key: SessionKey, requestId: String, optionId: String): Boolean = try {
        call(key.server, "respond_permission", jsonOf("sessionId" to key.id, "requestId" to requestId, "optionId" to optionId))
        retire(key, requestId)
        true
    } catch (e: Exception) {
        lastError = e.message
        false
    }

    /** Answers keyed by each question's own text, which is how the CLI matches them. */
    suspend fun answer(key: SessionKey, requestId: String, answers: Map<String, String>): Boolean = try {
        call(key.server, "answer_questions", jsonOf("sessionId" to key.id, "requestId" to requestId, "answers" to answers))
        retire(key, requestId)
        true
    } catch (e: Exception) {
        lastError = e.message
        false
    }

    /**
     * Answers `dray secret request`: a pasted `value`, the saved one named `from`, or neither to
     * decline. The value goes to the session's own server and nowhere else on the phone.
     */
    suspend fun answerSecret(
        key: SessionKey, requestId: String, value: String?, keep: Boolean, useSaved: Boolean, always: Boolean, from: String?,
    ) {
        call(
            key.server, "answer_secret_request",
            jsonOf(
                "sessionId" to key.id, "requestId" to requestId, "value" to value, "keep" to keep,
                "useSaved" to useSaved, "always" to always, "from" to from,
            ),
        )
        retire(key, requestId)
    }

    private fun retire(key: SessionKey, requestId: String) {
        asks[key]?.let { list -> asks[key] = list.filter { it.payload.askId != requestId } }
    }

    /** The agents a server runs, for the reply dock's agent row. */
    suspend fun agents(server: String): List<com.yogesh.dray.model.AgentAvailability> =
        runCatching { decodeList<com.yogesh.dray.model.AgentAvailability>(call(server, "agent_availability")) }.getOrDefault(emptyList())

    /** The models a harness offers on a server, for the reply dock's picks. */
    suspend fun models(server: String, harness: String): List<com.yogesh.dray.model.Model> =
        runCatching { decodeList<com.yogesh.dray.model.Model>(call(server, "list_models", jsonOf("harness" to harness))) }.getOrDefault(emptyList())

    // Events

    private fun handle(server: String, name: String, frame: JsonObject) {
        val payload = frame["payload"]
        botFrame(server, name, payload)
        when (name) {
            "agent_event" -> AgentEvent.decode(payload)?.let { apply(SessionKey(server, it.sessionId), it) }
            "live_state" -> {
                val live = payload ?: return
                // Replaces what is held: a card answered while the socket was down goes.
                asks.keys.filter { it.server == server }.forEach { asks.remove(it) }
                tasks.keys.filter { it.server == server }.forEach { tasks.remove(it) }
                // Open secret cards ride apart from `asks`, logged and outliving the turn; absent from an older server.
                for (a in AgentEvent.list(live["asks"]) + AgentEvent.list(live["secrets"])) {
                    val k = SessionKey(server, a.sessionId)
                    if (asks[k].orEmpty().none { it.payload.askId == a.payload.askId }) asks[k] = asks[k].orEmpty() + a
                }
                for (t in AgentEvent.list(live["tasks"])) {
                    (t.payload as? Payload.BackgroundTasks)?.let { tasks[SessionKey(server, t.sessionId)] = it.tasks }
                }
                live["queued"]?.let { held ->
                    queued.keys.filter { it.server == server }.forEach { queued.remove(it) }
                    for (q in decodeList<QueueChanged>(held)) if (q.queued.isNotEmpty()) queued[SessionKey(server, q.sessionId)] = q.queued
                }
                serving.keys.filter { it.server == server }.forEach { serving.remove(it) }
                for (s in decodeList<ServingEvent>(live["serving"])) if (s.ports.isNotEmpty()) serving[SessionKey(server, s.sessionId)] = s.ports
            }
            "session_serving" -> decodeOrNull<ServingEvent>(payload)?.let { s ->
                val k = SessionKey(server, s.sessionId)
                if (s.ports.isEmpty()) serving.remove(k) else serving[k] = s.ports
            }
            "queue_changed" -> decodeOrNull<QueueChanged>(payload)?.let { q ->
                // Every client's sends, the desktop's and the CLI's included; `send_msg` answers only its caller.
                val k = SessionKey(server, q.sessionId)
                if (q.queued.isEmpty()) queued.remove(k) else queued[k] = q.queued
            }
            "session_status" -> decodeOrNull<StatusEvent>(payload)?.let { s ->
                val key = SessionKey(server, s.sessionId)
                statuses[key] = s
                notice(key)
                val item = items[key]
                val ended = item?.busy == true && s.status != "in_progress"
                // A turn ending is when a pull request appears.
                if (ended) scope.launch { loadMarks(server, force = true, only = setOf(item!!.projectPath)) }
                if (item != null) setItem(key, item.copy(status = s.status, modified = s.modified ?: item.modified))
                if (s.status != "in_progress") strand(key)
                // Live events reach memory alone; the turn's end re-reads it so a cold open has the reply.
                if (ended && transcripts[key] != null) scope.launch { reload(key) }
            }
            "session_title" -> decodeOrNull<TitleEvent>(payload)?.let { t ->
                val key = SessionKey(server, t.sessionId)
                items[key]?.let { setItem(key, it.copy(title = t.title)) }
            }
            "session_deleted" -> decodeOrNull<DeletedEvent>(payload)?.let { forget(SessionKey(server, it.sessionId)) }
            "bots_changed" -> scope.launch { loadBots(server) }
            // Any client saved or dropped a draft, the CLI included: the drafts view reads again.
            "drafts_changed" -> draftsRevision++
            // Saved secrets moved on that server, from any client or a card: Settings › Secrets reads again.
            "secrets_changed" -> secretsRevision[server] = (secretsRevision[server] ?: 0) + 1
            "clone_progress" -> decodeOrNull<com.yogesh.dray.model.CloneProgress>(payload)?.let { p ->
                cloneProgress[server] = cloneProgress[server].orEmpty() + (p.slug to p.line)
            }
            "machines_shared" -> decodeOrNull<Sharing>(payload)?.let { share(server, it.machines) }
            "session_created", "session_changed" -> decodeOrNull<SessionItem>(payload)?.let { item ->
                SessionKey(server, item.sessionId).let { announced[it] = (announced[it] ?: 0) + 1 }
                dropStalePick(SessionKey(server, item.sessionId), item)
                setItem(SessionKey(server, item.sessionId), item)
                scope.launch { loadMarks(server, force = false, only = setOf(item.projectPath)) }
                // `bots_changed` comes from the CLI alone, and a bot the app made is first seen as its chat.
                if (name == "session_created" && bots[server].orEmpty().none { it.path == item.cwd }) scope.launch { loadBots(server) }
            }
        }
    }

    /** An id the index does not name re-reads it, once per burst: what is left for a server from before `session_created`. */
    private fun notice(key: SessionKey) {
        if (items[key] != null || key.server in reading) return
        reading += key.server
        scope.launch {
            loadIndex(key.server)
            reading -= key.server
            loadMarks(key.server, force = false)
        }
    }

    private fun apply(key: SessionKey, e: AgentEvent) {
        notice(key)
        when (val p = e.payload) {
            is Payload.PermissionRequested, is Payload.QuestionsAsked ->
                if (asks[key].orEmpty().none { it.payload.askId == p.askId }) asks[key] = asks[key].orEmpty() + e
            is Payload.PermissionDecided -> retire(key, p.requestId)
            // A task's ask of its bot on another machine is that chat's card, never this one's.
            is Payload.SecretRequested ->
                if (!p.request.bot && asks[key].orEmpty().none { it.payload.askId == p.askId }) asks[key] = asks[key].orEmpty() + e
            is Payload.SecretAnswered -> retire(key, p.answer.requestId)
            is Payload.BackgroundTasks -> {
                tasks[key] = p.tasks
                serving.remove(key)
                if (p.tasks.isEmpty() && items[key]?.busy != true) strand(key)
            }
            is Payload.UserMessage -> queued[key]?.let { q -> queued[key] = q.filter { it.text != p.text } }
            // A move made anywhere, even where its `session_changed` was missed: logged, so a catch-up carries it too.
            is Payload.AgentSwitched -> {
                items[key]?.let { if (it.harness != p.to) setItem(key, it.copy(harness = p.to)) }
                if (botState.unsent[key]?.harness == p.to) botState.unsent.remove(key)
            }
            else -> {}
        }
        if (!e.payload.isTransient) transcripts[key]?.let { transcripts[key] = it.plus(e) }
    }

    /**
     * A pick naming the agent a task already runs is spent: kept, a missed `agent_switched` would
     * move the task back unasked. A bot chat's keeps a model the sheet changed. Store.swift's.
     */
    private fun dropStalePick(key: SessionKey, item: SessionItem) {
        val p = botState.unsent[key] ?: return
        if (p.harness == item.harness && (bot(key) == null || p.model == item.model)) botState.unsent.remove(key)
    }

    /**
     * Drops a session's cards once nothing could answer them: no turn running and no task left — the
     * server's own rule. A secret card stays: its answer goes to a file and a fresh prompt, not the child.
     */
    private fun strand(key: SessionKey) {
        if (items[key]?.busy == true || !tasks[key].isNullOrEmpty()) return
        val kept = asks[key].orEmpty().filter { it.payload is Payload.SecretRequested }
        if (kept.isEmpty()) asks.remove(key) else asks[key] = kept
    }

    /** `/file`'s URL for a path on a server, without the token: images send it as a header. */
    fun fileUrl(server: String, path: String, withToken: Boolean = false): String? {
        val c = connections[server] ?: return null
        val base = c.httpBase ?: return null
        val enc = { s: String -> URLEncoder.encode(s, "UTF-8").replace("+", "%20") }
        val p = path.removePrefix("file://")
        return buildString {
            append("$base/file?")
            if (withToken) append("token=${enc(c.token)}&")
            append("path=${enc(p)}")
            c.via?.let { append("&via=${enc(it)}") }
        }
    }

    companion object {
        /** How long a server may stay down before a session on it says so. */
        const val LOST_AFTER_MS = 10_000L
        private val copyIdsSerializer = MapSerializer(String.serializer(), String.serializer())
    }
}

@Serializable
data class CachedList(val items: List<SessionItem>, val projects: List<Project>, val bots: List<Bot>)

/** Files under the cache dir, which the system may clear: everything here is read again from its server. */
class Cache(private val root: File) {
    private fun folder(server: String) = File(root, server)

    fun forget(server: String) {
        folder(server).deleteRecursively()
    }

    fun readList(server: String): CachedList? =
        runCatching { wireJson.decodeFromString(CachedList.serializer(), File(folder(server), "list.json").readText()) }.getOrNull()

    fun writeList(server: String, list: CachedList) = write(File(folder(server), "list.json"), wireJson.encodeToString(CachedList.serializer(), list))

    /** The id is the server's to pick, so it is encoded down to one name that cannot leave the folder. */
    private fun transcriptFile(key: SessionKey) = File(folder(key.server), "t-" + URLEncoder.encode(key.id, "UTF-8") + ".json")

    fun readTranscript(key: SessionKey): JsonElement? =
        runCatching { wireJson.parseToJsonElement(transcriptFile(key).readText()) }.getOrNull()?.takeUnless { it is JsonNull }

    fun writeTranscript(key: SessionKey, raw: String) = write(transcriptFile(key), raw)

    /** A page's last read across every server, by page name: the pull requests and issues lists. */
    fun readPage(name: String): String? = runCatching { File(root, "page-$name.json").readText() }.getOrNull()

    fun writePage(name: String, text: String) = write(File(root, "page-$name.json"), text)

    private fun write(file: File, text: String) {
        runCatching {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(text)
            tmp.renameTo(file)
        }
    }
}
