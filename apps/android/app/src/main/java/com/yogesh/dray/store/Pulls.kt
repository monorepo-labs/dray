package com.yogesh.dray.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.yogesh.dray.model.PrSearch
import com.yogesh.dray.model.PrUnavailable
import com.yogesh.dray.model.ProjectKey
import com.yogesh.dray.model.PullRow
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.marksRepo
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.wire.Bot
import com.yogesh.dray.wire.PrMark
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.wireJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

// Pulls.swift's `PullsModel` and the Store helpers it reads through.

/**
 * Where the phone asks GitHub's search and the issue trackers: the Mac app's own server, whose
 * `gh` and keys are the reader's, else the first connected.
 */
val Store.trackerServer: String?
    get() {
        val up = live.filter { serverState[it.id] == ConnState.Connected }
        return (up.firstOrNull { connection(it.id)?.welcome?.dictation == true } ?: up.firstOrNull())?.id
    }

/**
 * [trackerServer], else the server a page last read through while it is still switched on, so its
 * kept answers draw before one is up. One switched off never stands in: its answers stay hidden.
 */
fun Store.trackerOr(last: String?): String? = trackerServer ?: last?.takeIf { h -> live.any { it.id == h } }

/** The bot a session is a task of, at any depth: its parents up to a bot's chat. */
fun Store.botOf(key: SessionKey): Bot? {
    var at = key
    repeat(8) {
        bot(at)?.let { return if (at == key) null else it }
        val parent = items[at]?.parentSessionId ?: return null
        at = items.keys.firstOrNull { it.id == parent && it.server == at.server } ?: items.keys.firstOrNull { it.id == parent } ?: return null
    }
    return null
}

/** A project path's repository, `host/owner/name`: its recorded remote, else its marks' links. */
fun Store.repoOf(server: String, path: String): String? =
    projects[server]?.firstOrNull { it.path == path }?.remote
        ?: marks[ProjectKey(server, path)]?.values?.firstNotNullOfOrNull { marksRepo(it.url) }

/** What the page keeps on disk: every read below, by the same keys, so a relaunch draws the last list at once. */
@Serializable
private data class PullsCache(
    val marks: Map<String, List<PrMark>> = emptyMap(),
    val searches: Map<String, PrSearch> = emptyMap(),
    val checkouts: Map<String, String> = emptyMap(),
    val owners: List<String> = emptyList(),
    val home: String? = null,
)

private fun ProjectKey.flat() = "$server\n$path"
private fun projectKey(flat: String) = ProjectKey(flat.substringBefore('\n'), flat.substringAfter('\n'))

/**
 * What the pull requests page reads: each repo's marks with listings for All, one search for the
 * rest. Kept for the app's life and on disk, so opening the page draws the last list at once and
 * reads behind it.
 */
class PullsModel(private val store: Store, private val cache: Cache) {
    val marks = mutableStateMapOf<ProjectKey, List<PrMark>>()
    val markErrors = mutableStateMapOf<ProjectKey, PrUnavailable>()
    val searches = mutableStateMapOf<String, PrSearch>()
    var searchError by mutableStateOf<PrUnavailable?>(null)
        private set
    /** Each searched repo's checkout, matched on the server's own remotes (`repo_checkouts`). */
    val checkouts = mutableStateMapOf<String, ProjectKey>()
    /** Who the search can narrow to: the reader, every owner met, their orgs. Gathered, never dropped. */
    val owners = mutableStateListOf<String>()
    /** The tracker server the last search went to, so its answer draws before any server is up. */
    var home by mutableStateOf<String?>(null)
        private set
    /** Reads in flight: the page's bar shows a spinner while any is. */
    var loading by mutableStateOf(0)
        private set
    private val readAt = mutableMapOf<String, Long>()

    init {
        cache.readPage("pulls")?.let { text ->
            runCatching { wireJson.decodeFromString(PullsCache.serializer(), text) }.getOrNull()?.let { c ->
                c.marks.forEach { (k, v) -> marks[projectKey(k)] = v }
                searches.putAll(c.searches)
                c.checkouts.forEach { (k, v) -> checkouts[k] = projectKey(v) }
                owners.addAll(c.owners)
                home = c.home
            }
        }
    }

    private fun save() {
        val snapshot = PullsCache(
            marks.mapKeys { it.key.flat() }, searches.toMap(), checkouts.mapValues { it.value.flat() }, owners.toList(), home,
        )
        store.scope.launch(Dispatchers.IO) { cache.writePage("pulls", wireJson.encodeToString(PullsCache.serializer(), snapshot)) }
    }

    private fun fresh(key: String) = System.currentTimeMillis() - (readAt[key] ?: 0) < 60_000

    /** A repo's marks, fresh for a minute unless forced; every key at once. A failed read keeps the last list. */
    suspend fun loadMarks(keys: List<ProjectKey>, force: Boolean) {
        val due = keys.filter { force || !fresh(it.flat()) }
        if (due.isEmpty()) return
        loading++
        try {
            coroutineScope {
                due.map { key ->
                    async {
                        try {
                            marks[key] = decodeList<PrMark>(store.call(key.server, "pr_marks", jsonOf("cwd" to key.path, "listing" to true)))
                            markErrors.remove(key)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            markErrors[key] = PrUnavailable.from(e)
                        }
                        readAt[key.flat()] = System.currentTimeMillis()
                    }
                }.awaitAll()
            }
            save()
        } finally {
            loading--
        }
    }

    /** Per server too: two servers may run `gh` as different accounts. */
    fun searchKey(server: String, filter: String, owner: String?) = "$server\u0001$filter\u0001${owner.orEmpty()}"

    /** One `pr_search`, fresh for a minute unless forced, then each repo's checkout on every server. */
    suspend fun search(filter: String, owner: String?, force: Boolean) {
        val server = store.trackerServer ?: return
        val key = searchKey(server, filter, owner)
        if (!force && searches[key] != null && fresh(key)) return
        loading++
        try {
            // An org owner is searched `org:`, a person `user:`; GitHub drops every PR on the wrong one.
            val org = owner?.let { o ->
                searches.values.any { s ->
                    s.orgs.any { it.equals(o, ignoreCase = true) } ||
                        s.prs.any { it.ownerIsOrg && it.repo.substringBefore('/').equals(o, ignoreCase = true) }
                }
            } ?: false
            val found = decodeOrNull<PrSearch>(store.call(server, "pr_search", jsonOf("owner" to owner, "org" to org, "filter" to filter)))
                ?: throw IllegalStateException("GitHub's answer could not be read.")
            searches[key] = found
            readAt[key] = System.currentTimeMillis()
            home = server
            searchError = null
            for (o in listOf(found.viewer) + found.prs.map { it.repo.substringBefore('/') } + found.orgs) {
                if (o.isNotEmpty() && o !in owners) owners += o
            }
            findCheckouts(found.prs.mapNotNull { marksRepo(it.mark.url) }.toSet())
            save()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            searchError = PrUnavailable.from(e)
        } finally {
            loading--
        }
    }

    /** The tracker's server first, so a repo checked out there and elsewhere reads through it. */
    private suspend fun findCheckouts(repos: Set<String>) {
        checkouts.entries.removeAll { store.serverState[it.value.server] != ConnState.Connected }
        val wanted = repos - checkouts.keys
        if (wanted.isEmpty()) return
        val tracker = store.trackerServer
        val servers = store.live.filter { store.serverState[it.id] == ConnState.Connected }.map { it.id }.sortedBy { it != tracker }
        for (server in servers) {
            val projects = store.projects[server].orEmpty()
            if (projects.isEmpty()) continue
            // A server from before `repo_checkouts` answers `unknown command`; its recorded remotes stand in.
            val found = runCatching {
                decodeOrNull<Map<String, String>>(store.call(server, "repo_checkouts", jsonOf(
                    "paths" to JsonArray(projects.map { JsonPrimitive(it.path) }),
                    "repos" to JsonArray(wanted.sorted().map { JsonPrimitive(it) }),
                )))
            }.getOrNull() ?: projects.mapNotNull { p -> p.remote?.takeIf { it in wanted }?.let { it to p.path } }.toMap()
            for ((repo, path) in found) if (repo !in checkouts) checkouts[repo] = ProjectKey(server, path)
        }
    }

    /** `inboxRows`: every open PR the keys' marks hold, once each, newest activity first. */
    fun markRows(keys: List<ProjectKey>): List<PullRow> {
        val seen = mutableSetOf<String>()
        val rows = mutableListOf<PullRow>()
        for (key in keys) for (mark in marks[key].orEmpty()) {
            val listing = mark.listing ?: continue
            val repo = marksRepo(mark.url) ?: continue
            if (mark.state != "OPEN" || !seen.add(mark.url.orEmpty())) continue
            rows += PullRow(key.server, key.path, repo, mark, listing)
        }
        return rows.sortedByDescending { it.listing.updatedAt }
    }

    /** The search's PRs, each read through its checkout where there is one and its slug where not. */
    fun searchRows(filter: String, owner: String?, home: String): List<PullRow> =
        searches[searchKey(home, filter, owner)]?.prs.orEmpty().mapNotNull { p ->
            val listing = p.mark.listing ?: return@mapNotNull null
            val repo = marksRepo(p.mark.url) ?: return@mapNotNull null
            val at = checkout(repo) ?: ProjectKey(home, "github:${p.repo}")
            PullRow(at.server, at.path, repo, p.mark, listing)
        }

    fun searched(server: String?, filter: String, owner: String?) = server != null && searches[searchKey(server, filter, owner)] != null

    /** A repo's checkout, where its server is still switched on: rows never point at one that is off. */
    private fun checkout(repo: String): ProjectKey? = checkouts[repo]?.takeIf { at -> store.live.any { it.id == at.server } }

    /** A row any read holds, by its link: what a PR's page opens on before its own read lands. */
    fun row(url: String): PullRow? {
        val on = store.live.map { it.id }.toSet()
        for ((key, list) in marks) {
            if (key.server !in on) continue
            val mark = list.firstOrNull { it.url == url } ?: continue
            return PullRow(key.server, key.path, marksRepo(url) ?: continue, mark, mark.listing ?: continue)
        }
        for ((key, s) in searches) {
            val server = key.substringBefore('\u0001')
            if (server !in on) continue
            val p = s.prs.firstOrNull { it.mark.url == url } ?: continue
            val repo = marksRepo(url) ?: continue
            val at = checkout(repo) ?: ProjectKey(server, "github:${p.repo}")
            return PullRow(at.server, at.path, repo, p.mark, p.mark.listing ?: continue)
        }
        return null
    }
}
