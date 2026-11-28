package com.yogesh.dray.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.yogesh.dray.model.Integrations
import com.yogesh.dray.model.Issue
import com.yogesh.dray.model.IssueDetail
import com.yogesh.dray.model.IssueFilters
import com.yogesh.dray.model.IssueUnavailable
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.wireJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** Everything one `list_issues` read is asked with; [key] is what its answer is filed under. */
data class IssueQuery(
    val server: String,
    val tracker: String,
    val scope: String,
    val closed: Boolean,
    val repo: String,
    val team: String?,
    val project: String?,
    val label: String?,
    val issueType: String?,
    val text: String,
) {
    val github: Boolean get() = tracker == "github"
    val key: String get() = listOf(server, tracker, scope, closed, repo, team, project, label, issueType, text).joinToString("\u0001")
    /** The same picks with no words: the list a search narrows while the tracker's own answer is out. */
    val unsearched: IssueQuery get() = copy(text = "")

    fun json(settled: Boolean) = jsonOf(
        "tracker" to tracker, "text" to text.ifEmpty { null }, "scope" to scope,
        "teamId" to if (github) repo else team, "projectId" to if (github) null else project,
        "label" to if (github) label else null, "issueType" to if (github) issueType else null, "settled" to settled,
    )
}

@Serializable
private data class IssuesCache(
    val lists: Map<String, List<Issue>> = emptyMap(),
    val integrations: Map<String, Integrations> = emptyMap(),
    val filters: Map<String, IssueFilters> = emptyMap(),
    val home: String? = null,
)

/**
 * What the issues page reads, kept for the app's life and on disk: a list per set of picks, each
 * server's trackers and each tracker's filters. Opening the page draws the last answer for its
 * picks at once and reads behind it. A search's answers are kept only in memory.
 */
class IssuesModel(private val store: Store, private val cache: Cache) {
    val lists = mutableStateMapOf<String, List<Issue>>()
    val settled = mutableStateMapOf<String, List<Issue>>()
    val errors = mutableStateMapOf<String, IssueUnavailable>()
    val integrations = mutableStateMapOf<String, Integrations>()
    val integrationsFailed = mutableStateMapOf<String, Boolean>()
    val filters = mutableStateMapOf<String, IssueFilters>()
    /** The tracker server last read through, so its answers draw before any server is up. */
    var home by mutableStateOf<String?>(null)
        private set
    var loading by mutableStateOf(0)
        private set
    /** When each list last landed, this launch only: a kept list draws, then reads again once a minute old. */
    private val readAt = mutableMapOf<String, Long>()
    /** Lists in the order they were read, so the file keeps the latest few. */
    private val order = ArrayDeque<String>()

    init {
        cache.readPage("issues")?.let { text ->
            runCatching { wireJson.decodeFromString(IssuesCache.serializer(), text) }.getOrNull()?.let { c ->
                lists.putAll(c.lists)
                order.addAll(c.lists.keys)
                integrations.putAll(c.integrations)
                filters.putAll(c.filters)
                home = c.home
            }
        }
    }

    private fun save() {
        val kept = order.filter { it.substringAfterLast('\u0001').isEmpty() }.takeLast(KEEP)
        val snapshot = IssuesCache(kept.mapNotNull { k -> lists[k]?.let { k to it } }.toMap(), integrations.toMap(), filters.toMap(), home)
        store.scope.launch(Dispatchers.IO) { cache.writePage("issues", wireJson.encodeToString(IssuesCache.serializer(), snapshot)) }
    }

    suspend fun readIntegrations(server: String) {
        try {
            decodeOrNull<Integrations>(store.call(server, "get_integrations"))?.let { integrations[server] = it }
            integrationsFailed.remove(server)
            home = server
            save()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            integrationsFailed[server] = true
        }
    }

    fun connected(server: String, integrations: Integrations) {
        this.integrations[server] = integrations
        save()
    }

    fun filtersKey(server: String, tracker: String, repo: String) = "$server\u0001$tracker\u0001$repo"

    suspend fun readFilters(server: String, tracker: String, repo: String) {
        val read = runCatching {
            decodeOrNull<IssueFilters>(store.call(server, "list_issue_filters",
                jsonOf("tracker" to tracker, "repo" to if (tracker == "github" && repo.isNotEmpty()) repo else null)))
        }.getOrNull() ?: return
        filters[filtersKey(server, tracker, repo)] = read
        save()
    }

    /** A failed read keeps what was on screen; the line above it says it is stale. */
    suspend fun list(q: IssueQuery, force: Boolean, withSettled: Boolean) {
        if (!force && System.currentTimeMillis() - (readAt[q.key] ?: 0) < 60_000) return
        loading++
        try {
            val read = decodeList<Issue>(store.call(q.server, "list_issues", jsonOf("query" to q.json(q.github && q.closed), "limit" to 100)))
            lists[q.key] = read
            errors.remove(q.key)
            readAt[q.key] = System.currentTimeMillis()
            order.remove(q.key)
            order.addLast(q.key)
            settled.remove(q.key)
            if (withSettled) listSettled(q)
            save()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            errors[q.key] = IssueUnavailable.from(e)
        } finally {
            loading--
        }
    }

    /** Linear's Done and Cancelled, read only once their fold is opened. */
    suspend fun listSettled(q: IssueQuery) {
        settled[q.key] = runCatching {
            decodeList<Issue>(store.call(q.server, "list_issues", jsonOf("query" to q.json(true), "limit" to 100)))
        }.getOrDefault(emptyList())
    }

    /**
     * Puts an edited or freshly read issue back where it now belongs in every list holding it:
     * GitHub's Open and Closed are two lists, Linear's Done and Cancelled draw from [settled].
     */
    fun edited(next: Issue) {
        val closed = next.state.kind in setOf("completed", "canceled")
        val done = next.tracker == "linear" && closed
        for ((k, list) in lists.toMap()) {
            val i = list.indexOfFirst { it.id == next.id }
            if (i < 0) continue
            val leaves = done || (next.tracker == "github" && closed != closedList(k))
            lists[k] = if (leaves) list.filterNot { it.id == next.id } else list.toMutableList().also { it[i] = next }
            settled[k]?.let { s -> settled[k] = if (done) s.filterNot { it.id == next.id } + next else s.filterNot { it.id == next.id } }
        }
        for ((k, list) in settled.toMap()) {
            val i = list.indexOfFirst { it.id == next.id }
            if (i < 0) continue
            if (done) settled[k] = list.toMutableList().also { it[i] = next }
            else { settled[k] = list.filterNot { it.id == next.id }; lists[k]?.let { l -> lists[k] = l + next } }
        }
        save()
    }

    /** An issue's own read: a row listed before it moved on its tracker follows it, so the list never shows a closed issue open. */
    fun refreshed(next: Issue) {
        if ((lists.values + settled.values).any { l -> l.any { it.id == next.id && it.state.id != next.state.id } }) edited(next)
    }

    /** A row any list holds, by its id: what an issue's page opens on before its own read lands. */
    fun issue(id: String): Issue? = (lists.values + settled.values).firstNotNullOfOrNull { l -> l.firstOrNull { it.id == id } }

    /** Opened issues this launch, so going back to one draws it at once. */
    val details = mutableStateMapOf<String, IssueDetail>()

    private companion object {
        const val KEEP = 24

        /** Whether [IssueQuery.key] names GitHub's Closed list: `closed` is its fourth field. */
        fun closedList(key: String) = key.split('\u0001').getOrNull(3) == "true"
    }
}
