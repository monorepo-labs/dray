package com.yogesh.dray.model

import com.yogesh.dray.wire.PrListing
import com.yogesh.dray.wire.PrMark
import com.yogesh.dray.wire.SessionItem
import kotlinx.serialization.Serializable

// Pulls.swift's rules: one row per open PR, where it is filed, who it is about, and the tasks it has had.

/**
 * One open pull request on the page, `InboxRow` in `prInbox.ts`: `key` is what it is read through
 * on `server` — a checkout's path, or `github:owner/name` — and `repo` is [marksRepo]'s spelling.
 */
data class PullRow(val server: String, val key: String, val repo: String, val mark: PrMark, val listing: PrListing) {
    val id: String get() = mark.url ?: "$repo#${mark.number}"
    /** `owner/name`, for the row and the repository filter. */
    val repoName: String get() = prRepoSlug(mark.url) ?: repo
    val owner: String get() = repoName.substringBefore('/')
}

private val prUrl = Regex("""^https?://[^/]+/[^/]+/[^/]+(?=/pull/\d+)""")
private val scheme = Regex("""^https?://""")

/** `host/owner/name`, lowercased, off a PR's link: `marksRepo` in `pr.ts`. */
fun marksRepo(url: String?): String? {
    val m = url?.let { prUrl.find(it) } ?: return null
    return m.value.replace(scheme, "").lowercase()
}

/** `owner/name` off a PR's link, the host kept only where it is not github.com: `prRepoSlug`. */
fun prRepoSlug(url: String?): String? {
    val repo = marksRepo(url) ?: return null
    val parts = url!!.replace(scheme, "").split('/').take(3)
    if (parts.size != 3) return repo
    return if (parts[0].lowercase() == "github.com") "${parts[1]}/${parts[2]}" else parts.joinToString("/")
}

/** Where a PR sits on the page, in the order they are drawn. */
enum class InboxSection(val label: String) {
    NeedsYou("Needs you"), Ready("Ready to merge"), Running("Checks running"), Waiting("Waiting on review"), Draft("Drafts"),
}

/** `inboxSection`: drafts apart, then anything only the reader can move, then running checks, which outrank ready, then ready, and waiting for the rest. */
fun inboxSection(mark: PrMark): InboxSection {
    if (mark.isDraft) return InboxSection.Draft
    val verdict = mergeVerdict(mark.state, mark.isDraft, mark.mergeable ?: "UNKNOWN", mark.mergeStateStatus ?: "UNKNOWN")
    if (mark.checksState == "FAILING" || verdict == MergeVerdict.Conflict || mark.listing?.reviewRequested == true ||
        (mark.listing?.viewerDidAuthor == true && mark.reviewDecision == "CHANGES_REQUESTED")
    ) return InboxSection.NeedsYou
    if (mark.checksState == "RUNNING") return InboxSection.Running
    return if (verdict == MergeVerdict.Ready) InboxSection.Ready else InboxSection.Waiting
}

/** Who a PR is about. All lists the projects added to Dray through their marks; each of the others is one GitHub search. */
enum class PeopleFilter(val label: String, val search: String?, val empty: String) {
    All("All", null, ""),
    Involving("Involving me", "involves", " involving you"),
    Mine("Mine", "author", " of yours"),
    Review("Review requested", "review_requested", " awaiting your review"),
}

/**
 * Whether a row answers the search box: every word somewhere in its title, author, head branch
 * or repository, or a number the PR's own starts with (`#12` or `12`).
 */
fun PullRow.matches(query: String): Boolean {
    val words = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return true
    val fields = listOf(listing.title, listing.author, mark.headRefName, repoName).map { it.lowercase() }
    return words.all { w ->
        val n = w.removePrefix("#")
        (n.isNotEmpty() && n.all(Char::isDigit) && mark.number.toString().startsWith(n)) || fields.any { it.contains(w) }
    }
}

/**
 * Every task a PR has had, newest first: same repo and `sessionBranch` naming its head. Settled
 * ones stay; a fork's PR matches nothing. A task listed twice (paired directly and shared) keeps
 * the copy whose server is up. `sessionsForPr`.
 */
fun sessionsForPr(
    row: PullRow, items: Map<SessionKey, SessionItem>, repoOf: (String, String) -> String?, connected: (String) -> Boolean,
): List<SessionKey> {
    if (row.listing.isCrossRepository) return emptyList()
    val copies = linkedMapOf<String, Pair<SessionKey, SessionItem>>()
    for ((key, item) in items) {
        val branch = sessionBranch(item.branch, item.worktreeName, item.worktreeRemoved ?: false, null)
        if (branch != row.mark.headRefName) continue
        if (!((key.server == row.server && item.projectPath == row.key) || repoOf(key.server, item.projectPath) == row.repo)) continue
        val held = copies[item.sessionId]
        if (held != null && (connected(held.first.server) || !connected(key.server))) continue
        copies[item.sessionId] = key to item
    }
    return copies.values.sortedByDescending { (_, item) -> item.created ?: item.modified }.map { it.first }
}

/** `pr_search`'s answer: the reader's open PRs across GitHub and the owners to narrow by. */
@Serializable
data class PrSearch(val viewer: String = "", val orgs: List<String> = emptyList(), val prs: List<SearchedPr> = emptyList())

@Serializable
data class SearchedPr(val repo: String = "", val ownerIsOrg: Boolean = false, val mark: PrMark)

@Serializable
data class PrLabel(val name: String = "", val color: String = "")

/** `state` is `requested`, `approved`, `changes_requested` or `commented`; a word this build cannot spell still draws. */
@Serializable
data class PrReviewer(val name: String = "", val avatar: String? = null, val state: String = "")

/**
 * `pr_detail`'s answer: what a page on one PR draws beyond `prs_for_branch`'s read of it — its
 * description, labels, reviewers and when it was opened.
 */
@Serializable
data class PrDetail(
    val body: String = "",
    val createdAt: String = "",
    val authorAvatar: String? = null,
    val labels: List<PrLabel> = emptyList(),
    val reviewers: List<PrReviewer> = emptyList(),
)

private val htmlComment = Regex("<!--[\\s\\S]*?-->")
private val imgTag = Regex("""<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>""", RegexOption.IGNORE_CASE)
private val imgAlt = Regex("""\balt\s*=\s*["']([^"']*)["']""", RegexOption.IGNORE_CASE)
private val anchor = Regex("""<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)</a>""", RegexOption.IGNORE_CASE)
private val breakTag = Regex("""<br\s*/?>""", RegexOption.IGNORE_CASE)
private val blockTag = Regex("""</?(?:p|div|details|summary|h[1-6]|table|thead|tbody|tr|picture|source)\b[^>]*>""", RegexOption.IGNORE_CASE)
private val inlineTag = Regex("""</?(?:b|i|em|strong|span|sub|sup|kbd|code|ins|del|center)\b[^>]*>""", RegexOption.IGNORE_CASE)
private val markdownImage = Regex("""!\[([^\]]*)]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)""")

/**
 * A PR description as the phone's markdown draws it. GitHub's own uploads arrive as `<img>` tags
 * and screenshots often sit in a before/after table, but only an image alone on its line draws as
 * a picture: so tags become markdown, and each image in a sentence or a table moves to a line of
 * its own after it (after the whole table, which a line between rows would break). Code is kept as written.
 */
fun prBodyMarkdown(body: String): String {
    val out = mutableListOf<String>()
    val pending = mutableListOf<String>()
    var fenced = false
    fun flush() { out.addAll(pending); pending.clear() }
    val text = body.replace("\r\n", "\n").replace(htmlComment, "")
    for (raw in text.split('\n')) {
        if (raw.trim().startsWith("```")) { flush(); fenced = !fenced; out += raw; continue }
        if (fenced) { out += raw; continue }
        var line = raw
            .replace(imgTag) { m -> "![${imgAlt.find(m.value)?.groupValues?.get(1).orEmpty()}](${m.groupValues[1]})" }
            .replace(anchor) { m -> if (m.groupValues[2].contains("![")) m.groupValues[2] else "[${m.groupValues[2].trim()}](${m.groupValues[1]})" }
            .replace(breakTag, " ")
            .replace(blockTag, "")
            .replace(inlineTag, "")
        val trimmed = line.trim()
        val alone = markdownImage.matchEntire(trimmed) != null
        val table = trimmed.startsWith("|")
        if (!table) flush()
        if (!alone && markdownImage.containsMatchIn(line)) {
            val images = markdownImage.findAll(line).map { "![${it.groupValues[1]}](${it.groupValues[2]})" }.toList()
            line = line.replace(markdownImage) { it.groupValues[1] }
            if (table) pending += images
            else { out += line; out += images; continue }
        }
        out += line
    }
    flush()
    return out.joinToString("\n").replace(Regex("\n{3,}"), "\n\n").trim()
}
