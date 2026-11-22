package com.yogesh.dray.store

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
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
import com.yogesh.dray.net.socketUrl
import com.yogesh.dray.wire.AgentEvent
import com.yogesh.dray.wire.BackgroundTask
import com.yogesh.dray.wire.Bot
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
import com.yogesh.dray.wire.wireJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.builtins.ListSerializer
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
data class Via(val parent: String, val machine: String)

/** A relayed machine's id, the same on every launch so its transcripts survive a reconnect. */
private fun relayedId(parent: String, machine: String): String {
    val d = MessageDigest.getInstance("SHA-256").digest("$parent/$machine".toByteArray())
    val msb = d.take(8).fold(0L) { a, b -> (a shl 8) or (b.toLong() and 0xff) }
    val lsb = d.drop(8).take(8).fold(0L) { a, b -> (a shl 8) or (b.toLong() and 0xff) }
    return UUID(msb, lsb).toString().uppercase()
}

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
    var projects by mutableStateOf(mapOf<String, List<Project>>())
        private set
    /** Each repo's PR marks by branch, as `pr_marks` last answered. */
    val marks = mutableStateMapOf<ProjectKey, Map<String, PrMark>>()
    /** Each session's unsent reply, kept across leaving the screen. */
    val drafts = mutableStateMapOf<SessionKey, String>()
    var lastError by mutableStateOf<String?>(null)
    /** False while the device has no network at all, which every server shares. */
    var online by mutableStateOf(true)
        private set
    /** A server that connected and then failed to read its sessions. */
    val loadErrors = mutableStateMapOf<String, String>()
    /** A transcript that could not be read with nothing of it held yet. */
    val transcriptErrors = mutableStateMapOf<SessionKey, String>()
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

    /** A server came up: push hands it this phone's handle. */
    var onConnected: (String) -> Unit = {}
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

    /** Appearance's Hide sessions: home shows bots alone. */
    var hideSessions: Boolean
        get() = hideSessionsState
        set(on) { hideSessionsState = on; prefs.edit().putBoolean("list.hideSessions", on).apply() }
    private var hideSessionsState by mutableStateOf(prefs.getBoolean("list.hideSessions", false))

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
        val cm = context.getSystemService(ConnectivityManager::class.java)
        online = cm.activeNetwork?.let { cm.getNetworkCapabilities(it)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) } ?: false
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scope.launch {
                    // The network coming back retries every server at once, rather than each sitting out its backoff.
                    if (!online) { online = true; resume(now = true) }
                }
            }
            override fun onLost(network: Network) {
                scope.launch { online = cm.activeNetwork != null }
            }
        })
    }

    // Servers

    val live: List<Server> get() = servers.filter { it.on }

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
            save()
            return start(moved)
        }
        val s = Server(UUID.randomUUID().toString().uppercase(), name, url)
        secrets.set(s.id, token)
        servers = servers + s
        save()
        start(s)
    }

    fun removeServer(s: Server) {
        for (gone in listOf(s) + servers.filter { it.via?.parent == s.id }) onRemoving(gone)
        forget(s.id)
        secrets.delete(s.id)
        save()
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
    }

    /** A new token for a server whose old one was refused, tried at once. */
    fun updateToken(id: String, token: String) {
        secrets.set(id, token)
        connections[id]?.update(token)
        for (s in servers) if (s.via?.parent == id) connections[s.id]?.update(token)
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
    }

    /** Coming back to the front reconnects; `now` also asks servers that stopped, as a Retry does. */
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
            ConnState.Connected -> { downSince.remove(id); lost = lost - id }
            // Waiting cannot fix a refused token or a version apart.
            is ConnState.Failed -> lost = lost + id
            else -> {
                if (downSince[id] != null) return
                val since = System.currentTimeMillis()
                downSince[id] = since
                scope.launch {
                    delay(LOST_AFTER_MS)
                    if (downSince[id] == since) lost = lost + id
                }
            }
        }
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
            if (state == ConnState.Connected) scope.launch { connected(s.id) }
        }
        c.onEvent = { name, frame -> handle(s.id, name, frame) }
        connections[s.id] = c
        restoreList(s.id)
        c.resume()
    }

    /** Brings `parent`'s relayed servers in line with what it shares. */
    private fun share(parent: String, machines: List<Sharing.Machine>) {
        val p = servers.firstOrNull { it.id == parent && it.via == null } ?: return
        for (s in servers.filter { it.via?.parent == parent && machines.none { m -> m.id == it.via.machine } }) forget(s.id)
        for (m in machines) {
            val id = relayedId(parent, m.id)
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

    private fun setItem(key: SessionKey, item: SessionItem?) {
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
        scope.launch { loadBots(server) }
        scope.launch { loadShared(server) }
        onConnected(server)
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

    var settledError by mutableStateOf<String?>(null)
        private set

    /** A status event that arrived while a read was out is newer than the read, so it wins. */
    private fun merged(key: SessionKey, read: SessionItem): SessionItem {
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
        val list = items.filter { (key, item) ->
            item.hidden != true && (item.archived == true) == settled &&
                (project == null || project == item.project) &&
                // A bot's chat is its row in the bots section, never a task row.
                !(!settled && chats[key.server].orEmpty().any { samePath(it, item.cwd) }) &&
                // The index lands before the bots, and a bot's chat would draw as a task row until they do.
                (settled || known(key.server))
        }.map { Entry(it.key, it.value) }
        return stageRuns(list) { stage(it.key, it.item) }
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
        reload(key)
    }

    fun isLoading(key: SessionKey) = transcripts[key] == null && transcriptErrors[key] == null

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
     * keeps the session's as just re-read.
     */
    suspend fun send(
        key: SessionKey, text: String, model: String? = null, effort: String? = null,
        stance: String? = null, fast: Boolean? = null, effortMoved: Boolean = false,
    ): Boolean {
        val c = connections[key.server] ?: return false.also { lastError = "Not connected" }
        return try {
            val item = decodeOrNull<SessionItem>(c.call("get_session_by_id", jsonOf("sessionId" to key.id, "turns" to 0)).ok)
                ?: throw DrayError("Session not found")
            setItem(key, merged(key, item))
            val reply = c.call(
                "send_msg",
                jsonOf(
                    "sessionId" to key.id,
                    "prompt" to text,
                    "attachmentPaths" to emptyList<String>(),
                    "harness" to item.harness,
                    "model" to (model ?: item.model),
                    "effort" to (if (effortMoved) effort else effort ?: item.effort),
                    "permissionMode" to Picks.stanceFor(item.harness, stance ?: item.permissionMode),
                    "fast" to (fast ?: item.fast ?: false),
                    "cwd" to item.cwd,
                    "branch" to null,
                    "useWorktree" to false,
                    "worktreeName" to null,
                    "baseRef" to null,
                    "isNewSession" to false,
                ),
            ).ok
            decodeOrNull<SessionItem>(reply["snapshot"])?.let { setItem(SessionKey(key.server, it.sessionId), it) }
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

    /** The reader's emoji on the agent's message `messageId`. The badge and the agent's answer come back as events. */
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

    private fun retire(key: SessionKey, requestId: String) {
        asks[key]?.let { list -> asks[key] = list.filter { it.payload.askId != requestId } }
    }

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
                for (a in AgentEvent.list(live["asks"])) {
                    val k = SessionKey(server, a.sessionId)
                    asks[k] = asks[k].orEmpty() + a
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
            "bots_changed" -> scope.launch { loadBots(server) }
            // Any client saved or dropped a draft, the CLI included: the drafts view reads again.
            "drafts_changed" -> draftsRevision++
            "clone_progress" -> decodeOrNull<com.yogesh.dray.model.CloneProgress>(payload)?.let { p ->
                cloneProgress[server] = cloneProgress[server].orEmpty() + (p.slug to p.line)
            }
            "machines_shared" -> decodeOrNull<Sharing>(payload)?.let { share(server, it.machines) }
            "session_created", "session_changed" -> decodeOrNull<SessionItem>(payload)?.let { item ->
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
            is Payload.BackgroundTasks -> {
                tasks[key] = p.tasks
                serving.remove(key)
                if (p.tasks.isEmpty() && items[key]?.busy != true) strand(key)
            }
            is Payload.UserMessage -> queued[key]?.let { q -> queued[key] = q.filter { it.text != p.text } }
            else -> {}
        }
        if (!e.payload.isTransient) transcripts[key]?.let { transcripts[key] = it.plus(e) }
    }

    /** Drops a session's cards once nothing could answer them: no turn running and no task left — the server's own rule. */
    private fun strand(key: SessionKey) {
        if (items[key]?.busy != true && tasks[key].isNullOrEmpty()) asks.remove(key)
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

    private fun write(file: File, text: String) {
        runCatching {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(text)
            tmp.renameTo(file)
        }
    }
}
