package com.yogesh.dray.model

import com.yogesh.dray.wire.PrMark
import com.yogesh.dray.wire.wireJson
import kotlinx.serialization.Serializable

// Pr.swift: a branch's pull requests, why one can or cannot land, and comment text.

/**
 * `github.rs`'s `PullRequest`. Words GitHub chooses — state, check state, comment kind — stay
 * strings, so a new one reads as unknown rather than failing the list.
 */
@Serializable
data class PullRequest(
    val number: Int,
    val title: String = "",
    val url: String = "",
    val state: String = "OPEN",
    val isDraft: Boolean = false,
    val author: String = "",
    val baseRefName: String = "",
    val headRefName: String = "",
    val isCrossRepository: Boolean = false,
    val updatedAt: String = "",
    val mergeable: String = "UNKNOWN",
    val mergeStateStatus: String = "UNKNOWN",
    val reviewDecision: String? = null,
    val checks: List<PrCheck> = emptyList(),
    val comments: List<PrComment> = emptyList(),
    val additions: Int = 0,
    val deletions: Int = 0,
    val changedFiles: Int = 0,
) {
    val verdict: MergeVerdict get() = mergeVerdict(state, isDraft, mergeable, mergeStateStatus)

    /** Something GitHub is still working out, which sets how often an open sheet re-reads. */
    val settling: Boolean get() = state == "OPEN" && (mergeable == "UNKNOWN" || checks.any { it.state == "pending" })

    val failingChecks: Int get() = checks.count { it.state == "failure" }

    /** Checks running or failing on a PR that could otherwise merge: the merge button stays shut. */
    val checksHold: Boolean
        get() = state == "OPEN" && !isDraft && verdict != MergeVerdict.Conflict &&
            (failingChecks > 0 || checks.any { it.state == "pending" })

    /** This PR as the list's mark, so the title bar and the sheet draw the row's own glyph. */
    val mark: PrMark
        get() = PrMark(
            number = number, headRefName = "", isDraft = isDraft, state = state,
            checksState = when {
                checks.any { it.state == "failure" } -> "FAILING"
                checks.any { it.state == "pending" } -> "RUNNING"
                else -> "CLEAR"
            },
        )
}

@Serializable
data class PrCheck(val name: String = "", val state: String = "", val url: String? = null)

@Serializable
data class PrComment(
    val author: String = "",
    val avatar: String? = null,
    val body: String = "",
    val createdAt: String = "",
    val url: String = "",
    val kind: String = "comment",
    val path: String? = null,
    val resolved: Boolean = false,
    val replies: List<PrComment> = emptyList(),
) {
    /** Stable across polls, so a new reply or an edit keeps its row. Not the url alone: every review carries the PR's own. */
    val id: String get() = "$url|$createdAt|$author"
}

/** Why the server could not ask GitHub: `{"kind":…,"detail":…}`. */
@Serializable
data class PrUnavailable(val kind: String, val detail: String? = null) {
    /** The two the reader can install or log their way out of, which keep the button. */
    val keepsButton: Boolean get() = kind == "no_cli" || kind == "not_authenticated"

    /** The desktop panel's words; `other` carries `gh`'s own sentence. */
    val sentence: String
        get() = when (kind) {
            "no_cli" -> "GitHub CLI (gh) is not installed on this server. Run `dray setup` there to install it."
            "not_authenticated" -> "GitHub CLI is not logged in on this server. Run `gh auth login` there to see pull requests here."
            "no_remote" -> "This directory has no GitHub remote."
            else -> detail ?: kind
        }

    companion object {
        /**
         * `prs_for_branch` rejects with a typed object, which the connection hands over as its
         * JSON text; anything else is the call itself failing.
         */
        fun from(error: Throwable): PrUnavailable {
            val text = error.message ?: "Failed"
            return runCatching { wireJson.decodeFromString(serializer(), text) }.getOrNull() ?: PrUnavailable("other", text)
        }
    }
}

/** `work_status`'s answer, read for the branch a checkout is on. */
@Serializable
data class WorkStatus(
    val branch: String? = null,
    /** Uncommitted paths: whether the Changes screen offers Uncommitted. */
    val dirty: Int? = null,
)

enum class MergeVerdict { Merged, Closed, Conflict, Unknown, Draft, Behind, Blocked, Unstable, Ready }

/**
 * Why a pull request can or cannot land; `mergeVerdict` in `pr.ts`. The order is the whole
 * logic: a closed PR's merge state is stale, a conflict outranks everything open, a draft is
 * stored where the statuses below it are what GitHub recomputes while it says `UNKNOWN`.
 */
fun mergeVerdict(state: String, isDraft: Boolean, mergeable: String, mergeStateStatus: String): MergeVerdict = when {
    state == "MERGED" -> MergeVerdict.Merged
    state == "CLOSED" -> MergeVerdict.Closed
    mergeable == "CONFLICTING" || mergeStateStatus == "DIRTY" -> MergeVerdict.Conflict
    isDraft -> MergeVerdict.Draft
    mergeable == "UNKNOWN" -> MergeVerdict.Unknown
    else -> when (mergeStateStatus) {
        "BEHIND" -> MergeVerdict.Behind
        "BLOCKED" -> MergeVerdict.Blocked
        "UNSTABLE" -> MergeVerdict.Unstable
        "UNKNOWN" -> MergeVerdict.Unknown
        // `CLEAN` and `HAS_HOOKS`.
        else -> MergeVerdict.Ready
    }
}

/** The verdict in the reader's words: a label, and a line of why where one helps. Checks speak first, since `BLOCKED` is usually them. */
fun readiness(pr: PullRequest): Pair<String, String?> {
    if (pr.checksHold) {
        val n = pr.failingChecks
        return if (n > 0) "Checks not passing" to (if (n == 1) "1 check failed." else "$n checks failed.")
        else "Waiting on checks" to "Merge opens once they pass."
    }
    return when (pr.verdict) {
        MergeVerdict.Merged -> "Merged" to null
        MergeVerdict.Closed -> "Closed without merging" to null
        MergeVerdict.Conflict -> "Conflicts with base" to "Resolve against ${pr.baseRefName} before merging."
        MergeVerdict.Unknown -> "Checking mergeability…" to null
        MergeVerdict.Draft -> "Draft" to "Mark ready to request review and merge."
        MergeVerdict.Behind -> "Behind ${pr.baseRefName}" to "Update the branch before merging."
        MergeVerdict.Blocked -> "Blocked" to when (pr.reviewDecision) {
            "CHANGES_REQUESTED" -> "Changes were requested."
            "REVIEW_REQUIRED" -> "A review is required."
            else -> "A required check or rule is not satisfied."
        }
        MergeVerdict.Unstable -> "Checks not passing" to "Merging is allowed, but something is red."
        MergeVerdict.Ready -> "Ready to merge" to null
    }
}

/** How a merge lands on the base, the desktop's `METHOD_LABEL` and `METHOD_DETAIL` cut to a phone's width. */
enum class MergeMethod(val wire: String, val label: String, val detail: String) {
    Squash("squash", "Squash and merge", "All commits become one new commit."),
    Merge("merge", "Create a merge commit", "Every commit is kept, plus a merge commit."),
    Rebase("rebase", "Rebase and merge", "Each commit replayed onto the base.");

    fun landing(base: String): String = when (this) {
        Squash -> "All commits become one commit on $base."
        Merge -> "Every commit lands on $base, plus a merge commit."
        Rebase -> "Each commit is replayed onto $base."
    }
}

private val markerLine = Regex("^\\[[a-z-]+\\]: #", RegexOption.IGNORE_CASE)
private val spans = Regex("```[\\s\\S]*?(```|$)|<!--[\\s\\S]*?-->|`[^`\\n]*`")
private val tag = Regex("<[a-zA-Z/!][^>]*>")

/** A comment body as plain-ish text: bots hide state in `[vc]: #…` lines and HTML comments, and write HTML as often as markdown. */
fun commentText(body: String): String {
    // Marker lines go whole, backticks and all, before code is split out — but not inside a fence, where one is an example.
    var fenced = false
    val text = body.split('\n').filter { line ->
        if (line.startsWith("```")) fenced = !fenced
        fenced || !markerLine.containsMatchIn(line)
    }.joinToString("\n")
    // Code and HTML comments in one pass, whichever opens first winning, as markdown reads them:
    // code keeps its text whole (`Array<T>` is no tag), and a comment goes whole even when it holds backticks.
    val out = StringBuilder()
    var last = 0
    for (m in spans.findAll(text)) {
        out.append(prose(text.substring(last, m.range.first)))
        if (!m.value.startsWith("<!--")) out.append(m.value)
        last = m.range.last + 1
    }
    return (out.toString() + prose(text.substring(last))).trim()
}

private fun prose(text: String): String {
    var s = tag.replace(text, "")
    // `&amp;` last, or `&amp;lt;` would decode twice.
    for ((entity, char) in listOf("&lt;" to "<", "&gt;" to ">", "&quot;" to "\"", "&#39;" to "'", "&nbsp;" to " ", "&amp;" to "&")) {
        s = s.replace(entity, char)
    }
    return s
}
