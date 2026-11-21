package com.yogesh.dray.model

import com.yogesh.dray.wire.PrMark
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.parseDate

/** A session is named by its server and its id; nothing on the wire carries the server, so the socket a frame came on is the answer. */
data class SessionKey(val server: String, val id: String)

/** A project is named by its server and its path, the way a session is. */
data class ProjectKey(val server: String, val path: String)

data class Entry(val key: SessionKey, val item: SessionItem)

data class ListRow(val key: SessionKey, val item: SessionItem, val depth: Int)

/**
 * What a run of rows is waiting on, strongest first, which is also the order the runs are drawn
 * in — the desktop's `SESSION_STATES`. Mid-turn is not a stage: the row's orb says it.
 */
enum class Stage { Asking, Completed, Idle, UnreadPr, Pr, Checks, Merged, Aside }

data class Run(val stage: Stage, val rows: List<ListRow>)

/**
 * The desktop sidebar's live list (`sessionGroups` in Sidebar.tsx): one run per stage,
 * workspace-wide, drawn under no heading. A nest stays whole under its root and takes the
 * strongest stage anything in it holds.
 */
fun stageRuns(list: List<Entry>, now: Long = System.currentTimeMillis(), stage: (Entry) -> Stage): List<Run> {
    val (aside, active) = splitAside(list, now)
    val runs = mutableMapOf<Stage, MutableList<ListRow>>()
    val held = nests(active)
    val flat = held.flatten()
    fun strongest(rows: List<ListRow>) = rows.minOf { stage(Entry(it.key, it.item)) }
    // A short list is one run: there is nothing to scan in two rows.
    if (flat.size < 3) {
        if (flat.isNotEmpty()) runs[strongest(flat)] = flat.toMutableList()
    } else {
        for (nest in held) runs.getOrPut(strongest(nest)) { mutableListOf() } += nest
        // A run of one row between two breaks reads as a heading, so neighbouring
        // single-row stages in one family share a break.
        for (family in listOf(listOf(Stage.Asking, Stage.Completed), listOf(Stage.UnreadPr, Stage.Pr, Stage.Checks, Stage.Merged))) {
            var into: Stage? = null
            for (s in family) {
                val rows = runs[s] ?: continue
                if (rows.size > 1) into = null
                else if (into != null) { runs[into]!! += rows; runs.remove(s) }
                else into = s
            }
        }
    }
    val rest = nests(aside).flatten()
    if (rest.isNotEmpty()) runs.getOrPut(Stage.Aside) { mutableListOf() } += rest
    return Stage.entries.mapNotNull { s -> runs[s]?.let { Run(s, it) } }
}

/**
 * Rows in draw order, a spawned session under its parent, newest first at every level, cut
 * into nests at each root. A child whose parent is not listed draws as a root; a cycle costs
 * an odd order, never a lost row.
 */
private fun nests(list: List<Entry>): List<List<ListRow>> {
    val present = list.map { it.key }.toSet()
    fun parent(e: Entry): SessionKey? =
        e.item.parentSessionId?.let { SessionKey(e.key.server, it) }?.takeIf { it in present }
    val kids = mutableMapOf<SessionKey, MutableList<Entry>>()
    for (e in list) parent(e)?.let { kids.getOrPut(it) { mutableListOf() } += e }
    val newest = compareByDescending<Entry> { it.item.modified }

    val out = mutableListOf<MutableList<ListRow>>()
    val seen = mutableSetOf<SessionKey>()
    fun walk(e: Entry, depth: Int) {
        if (!seen.add(e.key)) return
        out.last() += ListRow(e.key, e.item, depth)
        for (k in kids[e.key].orEmpty().sortedWith(newest)) walk(k, depth + 1)
    }
    for (e in list.filter { parent(it) == null }.sortedWith(newest) + list.sortedWith(newest)) {
        if (e.key in seen) continue
        out += mutableListOf<ListRow>()
        walk(e, 0)
    }
    return out
}

/** Set aside by the reader, or untouched three days with nothing below still moving — the desktop's `splitAside`. */
private fun splitAside(list: List<Entry>, now: Long): Pair<List<Entry>, List<Entry>> {
    val kids = mutableMapOf<SessionKey, MutableList<Entry>>()
    for (e in list) e.item.parentSessionId?.let { kids.getOrPut(SessionKey(e.key.server, it)) { mutableListOf() } += e }
    fun stale(e: Entry) = now - (parseDate(e.item.modified) ?: now) > 3L * 24 * 3600 * 1000
    // Seeded false before the children are asked, so a cycle answers.
    val memo = mutableMapOf<SessionKey, Boolean>()
    fun moving(e: Entry): Boolean {
        memo[e.key]?.let { return it }
        memo[e.key] = false
        val v = (e.item.aside != true && !stale(e)) || kids[e.key].orEmpty().any { moving(it) }
        memo[e.key] = v
        return v
    }
    val aside = mutableListOf<Entry>()
    val rest = mutableListOf<Entry>()
    for (e in list) if (e.item.aside != true && moving(e)) rest += e else aside += e
    return aside to rest
}

/** One branch's mark out of every PR on it: open beats draft beats merged, ties to the first — `pickPrMark` in pr.ts. */
fun pickMark(prs: List<PrMark>): PrMark? {
    fun rank(p: PrMark) = if (p.state != "OPEN") 2 else if (p.isDraft) 1 else 0
    return prs.fold(null as PrMark?) { best, p -> if (best == null || rank(p) < rank(best)) p else best }
}

/** The branch a session's PR is looked up on: the desktop's `sessionBranch`. */
fun sessionBranch(branch: String?, worktreeName: String?, worktreeRemoved: Boolean, observed: String?): String? {
    if (worktreeRemoved) return branch
    if (!observed.isNullOrEmpty()) return observed
    return branch ?: worktreeName?.let { "worktree-$it" }
}

/** For each depth level above a row, whether the line under that level runs on past it: the elbows' rails. */
fun runsOn(rows: List<ListRow>, i: Int, level: Int): Boolean {
    for (j in i + 1 until rows.size) {
        val d = rows[j].depth
        if (d <= level) return false
        if (d == level + 1) return true
    }
    return false
}
