package com.yogesh.dray.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Changes.swift's model half: the wire, the unified diff and the file icon lookup.

/** `git.rs`'s `ChangedFile`: one path between two snapshots, with git's own numstat counts. */
@Serializable
data class ChangedFile(
    val path: String,
    /** A rename's name in the old snapshot, which its old side is read under. */
    val oldPath: String? = null,
    /** `added`, `modified`, `deleted` or `renamed`. */
    val status: String = "modified",
    val added: Int = 0,
    val removed: Int = 0,
    val binary: Boolean = false,
)

/**
 * `changes_since`' answer. `head` is the snapshot the read took, which a file's diff must be
 * read against, or a moving working tree shows a diff the list never counted.
 */
@Serializable
data class ChangeSet(
    val base: String,
    val head: String,
    val files: List<ChangedFile> = emptyList(),
    val added: Int = 0,
    val removed: Int = 0,
)

/** `file_change`'s answer: both sides of one file, or why a side is withheld (`binary` or `too_large`). */
@Serializable
data class FileVersions(val oldText: String? = null, val newText: String? = null, val unreadable: String? = null)

@Serializable
data class Commit(
    val sha: String,
    /** None on a root commit, which diffs against the empty tree. */
    val parent: String? = null,
    val subject: String = "",
    val body: String = "",
    val author: String = "",
    val authoredAt: String = "",
) {
    val base: String get() = parent ?: EMPTY_TREE
}

/** Git's empty tree, the base of a root commit, as in `commit.ts`. */
const val EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

sealed interface DiffRow {
    /** `number` is the new side's line, or the old side's on a removal. */
    data class Line(val sign: Char, val number: Int, val text: String) : DiffRow
    /** Unchanged lines folded out between hunks. */
    data class Gap(val count: Int) : DiffRow
    /** The line above ends its file with no newline, git's `\ No newline at end of file`. */
    data object NoNewline : DiffRow
}

/**
 * Carried on a file's last line when no newline follows it, so adding or dropping that
 * newline differs like any other edit. Never shown.
 */
private const val NO_EOL = '\u0001'

private fun diffLines(s: String?): List<String> {
    if (s.isNullOrEmpty()) return emptyList()
    // Split on "\n" alone, so a CRLF line keeps its CR and still splits per line.
    val all = s.split('\n').toMutableList()
    if (s.endsWith('\n')) all.removeAt(all.lastIndex) else all[all.lastIndex] = all.last() + NO_EOL
    return all
}

/** A unified diff with [context] lines around each change, from a Myers difference as Swift's own. */
fun unifiedDiff(old: String?, new: String?, context: Int = 3): List<DiffRow> {
    val a = diffLines(old)
    val b = diffLines(new)
    val (removed, inserted) = myers(a, b)
    // Lines neither side touched pair up one to one, in order.
    val all = ArrayList<DiffRow>(a.size + b.size)
    fun add(sign: Char, number: Int, text: String) {
        val bare = text.lastOrNull() == NO_EOL
        all += DiffRow.Line(sign, number, if (bare) text.dropLast(1) else text)
        if (bare) all += DiffRow.NoNewline
    }
    var i = 0
    var j = 0
    while (i < a.size || j < b.size) {
        when {
            i < a.size && i in removed -> { add('-', i + 1, a[i]); i++ }
            j < b.size && j in inserted -> { add('+', j + 1, b[j]); j++ }
            else -> { add(' ', j + 1, b[j]); i++; j++ }
        }
    }
    val keep = BooleanArray(all.size)
    all.forEachIndexed { k, row ->
        if (row is DiffRow.Line && row.sign != ' ') {
            for (n in maxOf(0, k - context)..minOf(all.size - 1, k + context)) keep[n] = true
        }
    }
    // The note goes wherever its line goes.
    all.forEachIndexed { k, row -> if (row == DiffRow.NoNewline && k > 0) keep[k] = keep[k - 1] }
    val out = ArrayList<DiffRow>()
    var folded = 0
    all.forEachIndexed { k, row ->
        if (keep[k]) {
            if (folded > 0) { out += DiffRow.Gap(folded); folded = 0 }
            out += row
        } else {
            folded++
        }
    }
    // Trailing unchanged lines go unsaid, as git leaves them.
    return out
}

/** About 120 MB of frontier before the diff gives up on a minimal script. */
private const val TRACE_BUDGET = 30_000_000L

/** Myers' shortest edit script: which of [a]'s lines go and which of [b]'s arrive. Common ends are trimmed first. */
private fun myers(a: List<String>, b: List<String>): Pair<Set<Int>, Set<Int>> {
    var start = 0
    while (start < a.size && start < b.size && a[start] == b[start]) start++
    var endA = a.size
    var endB = b.size
    while (endA > start && endB > start && a[endA - 1] == b[endB - 1]) { endA--; endB-- }
    val n = endA - start
    val m = endB - start
    val removed = HashSet<Int>()
    val inserted = HashSet<Int>()
    if (n == 0 || m == 0) {
        for (x in start until endA) removed += x
        for (y in start until endB) inserted += y
        return removed to inserted
    }
    val max = n + m
    val off = max
    var v = IntArray(2 * max + 2)
    // Each step keeps only the diagonals it could reach, so memory is D², not D·(N+M).
    val trace = ArrayList<IntArray>()
    var kept = 0L
    var found = false
    var d = 0
    while (d <= max && !found) {
        kept += 2L * d + 1
        if (kept > TRACE_BUDGET) {
            // Too far apart to walk back affordably: the middle reads as replaced whole.
            for (x in start until endA) removed += x
            for (y in start until endB) inserted += y
            return removed to inserted
        }
        trace += v.copyOfRange(off - d, off + d + 1)
        val next = v.copyOf()
        var k = -d
        while (k <= d) {
            var x = if (k == -d || (k != d && v[off + k - 1] < v[off + k + 1])) v[off + k + 1] else v[off + k - 1] + 1
            var y = x - k
            while (x < n && y < m && a[start + x] == b[start + y]) { x++; y++ }
            next[off + k] = x
            if (x >= n && y >= m) { found = true; break }
            k += 2
        }
        v = next
        if (!found) d++
    }
    // Walk back through each step's frontier to recover the edits.
    var x = n
    var y = m
    for (step in d downTo 1) {
        val pv = trace[step]
        fun at(k: Int) = pv[k + step]
        val k = x - y
        val prevK = if (k == -step || (k != step && at(k - 1) < at(k + 1))) k + 1 else k - 1
        val prevX = at(prevK)
        val prevY = prevX - prevK
        while (x > prevX && y > prevY) { x--; y-- }
        if (prevK == k + 1) inserted += start + prevY else removed += start + prevX
        x = prevX
        y = prevY
    }
    return removed to inserted
}

/** A path's folder and its name, the folder empty at the root. */
fun splitPath(path: String): Pair<String, String> {
    val cut = path.lastIndexOf('/')
    return if (cut < 0) "" to path else path.substring(0, cut) to path.substring(cut + 1)
}

/** `vscode-material-icons`' lookup, over its map as `file-icons.json` holds it. */
class FileIconMap(
    private val fileNames: Map<String, String>,
    private val fileExtensions: Map<String, String>,
    private val folderNames: Map<String, String>,
) {
    /**
     * The icon's name. Matched as the package matches: whole name, then lowercased, then
     * everything after the first dot, then after the last, then the three it names by hand,
     * since the map leaves them to VS Code's language ids.
     */
    fun name(path: String, folder: Boolean = false): String {
        val base = path.split('/').lastOrNull { it.isNotEmpty() } ?: path
        if (folder) return folderNames[base] ?: folderNames[base.lowercase()] ?: "folder"
        val suffix = base.indexOf('.').let { if (it < 0) base else base.substring(it + 1) }
        val ext = base.lastIndexOf('.').let { if (it < 0) base else base.substring(it + 1) }
        val byHand = when {
            base.endsWith(".html") -> "html"
            base.endsWith(".ts") -> "typescript"
            base.endsWith(".js") -> "javascript"
            else -> null
        }
        return fileNames[base] ?: fileNames[base.lowercase()] ?: fileExtensions[suffix] ?: fileExtensions[ext] ?: byHand ?: "file"
    }

    companion object {
        fun parse(json: String): FileIconMap {
            val root = Json.parseToJsonElement(json).jsonObject
            fun table(k: String) = (root[k] as? JsonObject)?.mapValues { it.value.jsonPrimitive.content }.orEmpty()
            return FileIconMap(table("fileNames"), table("fileExtensions"), table("folderNames"))
        }
    }
}
