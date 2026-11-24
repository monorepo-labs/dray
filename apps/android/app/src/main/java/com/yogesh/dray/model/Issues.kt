package com.yogesh.dray.model

import com.yogesh.dray.wire.wireJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

// Issues.swift's wire and rules: `list_issues` rows, an opened issue, a tracker's filters.

@Serializable
data class IssueState(
    val id: String = "",
    val name: String = "",
    /** `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled` or `other`. */
    val kind: String = "other",
    val color: String = "",
)

@Serializable
data class IssuePerson(val name: String = "", val avatar: String? = null)

@Serializable
data class TrackerLabel(val name: String = "", val color: String = "")

@Serializable
data class IssueGroup(val id: String = "", val name: String = "")

/** One row of `list_issues`. */
@Serializable
data class Issue(
    val tracker: String = "linear",
    val id: String,
    /** `DRA-53`, or `owner/name#12` on GitHub. */
    val identifier: String = "",
    val title: String = "",
    val url: String = "",
    val state: IssueState = IssueState(),
    /** `urgent`, `high`, `medium`, `low` or `none`. */
    val priority: String = "none",
    val assignee: IssuePerson? = null,
    val author: IssuePerson? = null,
    val labels: List<TrackerLabel> = emptyList(),
    val team: String? = null,
    val project: String? = null,
    val updatedAt: String = "",
    val pullRequests: List<Int> = emptyList(),
    val issueType: TrackerLabel? = null,
) {
    /** `#12` where every row is one repository's; Linear's is already short. */
    val short: String get() = identifier.lastIndexOf('#').let { if (it >= 0) identifier.substring(it) else identifier }
}

@Serializable
data class IssueComment(val author: IssuePerson = IssuePerson(), val body: String = "", val createdAt: String = "", val url: String? = null)

/** `get_issue`'s answer: the row's fields at its top, its text and talk, and its team's workflow. */
data class IssueDetail(val issue: Issue, val description: String?, val comments: List<IssueComment>, val states: List<IssueState>) {
    companion object {
        @Serializable
        private data class Extra(
            val description: String? = null,
            val comments: List<IssueComment> = emptyList(),
            val states: List<IssueState> = emptyList(),
        )

        fun decode(e: JsonElement): IssueDetail? {
            if (e !is JsonObject) return null
            val issue = runCatching { wireJson.decodeFromJsonElement<Issue>(e) }.getOrNull() ?: return null
            val extra = runCatching { wireJson.decodeFromJsonElement<Extra>(e) }.getOrDefault(Extra())
            return IssueDetail(issue, extra.description, extra.comments, extra.states)
        }
    }
}

@Serializable
data class IssueFilters(
    /** Linear's teams; GitHub's repositories. */
    val teams: List<IssueGroup> = emptyList(),
    val projects: List<IssueGroup> = emptyList(),
    val labels: List<TrackerLabel> = emptyList(),
    val issueTypes: List<TrackerLabel> = emptyList(),
)

@Serializable
data class TrackerAccount(val userName: String = "", val orgName: String = "")

@Serializable
data class Integrations(val linear: TrackerAccount? = null, val github: TrackerAccount? = null)

/** Why a tracker read failed: `{"kind":…,"detail":…}`. */
@Serializable
data class IssueUnavailable(val kind: String, val detail: String? = null) {
    /** `issueErrorText`. */
    fun sentence(tracker: String): String {
        val linear = tracker == "linear"
        return when (kind) {
            "unauthorized" -> if (linear) "Linear rejected the saved key. Disconnect it in Settings, then paste a new one."
            else "GitHub refused that read. Sign in again with `gh auth login`."
            "offline" -> if (linear) "Could not reach Linear." else "Could not reach GitHub."
            "not_connected" -> if (linear) "No issue tracker connected." else "Not signed in to GitHub. Run `gh auth login`."
            else -> detail ?: kind
        }
    }

    companion object {
        fun from(error: Throwable): IssueUnavailable {
            val text = error.message ?: "Failed"
            return runCatching { wireJson.decodeFromString(serializer(), text) }.getOrNull() ?: IssueUnavailable("other", text)
        }
    }
}

/** The status buckets Linear's half draws, in workflow order: `GROUPS` in `issue.ts`. */
val issueGroups = listOf(
    "started" to "In Progress", "triage" to "Triage", "unstarted" to "Todo", "backlog" to "Backlog",
    "completed" to "Done", "canceled" to "Cancelled", "other" to "Other",
)

val priorityLabels = mapOf("urgent" to "Urgent", "high" to "High priority", "medium" to "Medium priority", "low" to "Low priority", "none" to "No priority")
val priorities = listOf("urgent", "high", "medium", "low", "none")

/** The tag a prompt names an issue by: `issueTag`, which the server resolves on send. */
fun issueTag(identifier: String, title: String) = if (title.isEmpty()) "#$identifier" else "#$identifier $title"

/**
 * Whether a held row answers the search box while the tracker's own search is still out: every
 * word in its title, identifier, assignee or author.
 */
fun Issue.matches(query: String): Boolean {
    val words = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    val fields = listOfNotNull(title, identifier, assignee?.name, author?.name).map { it.lowercase() }
    return words.all { w -> fields.any { it.contains(w.removePrefix("#")) } }
}

/** A tracker's `#rrggbb` (GitHub leaves the `#` off) as ARGB; grey for anything else. */
fun trackerColor(hex: String): Long {
    val h = hex.removePrefix("#")
    val rgb = if (h.length == 6) h.toLongOrNull(16) else null
    return 0xFF000000 or (rgb ?: 0xBEC2C8)
}
