package com.yogesh.dray.ui

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Commit
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Difference
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.caverock.androidsvg.RenderOptions
import com.caverock.androidsvg.SVG
import com.yogesh.dray.model.ChangeSet
import com.yogesh.dray.model.ChangedFile
import com.yogesh.dray.model.Commit
import com.yogesh.dray.model.DiffRow
import com.yogesh.dray.model.FileIconMap
import com.yogesh.dray.model.FileVersions
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.WorkStatus
import com.yogesh.dray.model.splitPath
import com.yogesh.dray.model.unifiedDiff
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.store.Store
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.parseDate
import com.yogesh.dray.wire.shortAge
import com.yogesh.dray.wire.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap

// Changes.swift: what the agent changed, three ways, read only.

/** The Changes button in a task's title bar. */
@Composable
fun ChangesButton(onClick: () -> Unit) {
    IconButton(onClick) { Icon(Icons.Outlined.Difference, "Changes", Modifier.size(22.dp), tint = Dray.text) }
}

private enum class ChangesTab(val label: String) { Uncommitted("Uncommitted"), Branch("Branch"), Commits("Commits") }

/** A screen pushed over the tabs: a commit's own changes, or one file's diff. */
private sealed interface ChangesPage {
    data class OneCommit(val commit: Commit) : ChangesPage
    data class Diff(val base: String, val head: String, val file: ChangedFile) : ChangesPage
}

/**
 * What the agent changed, three ways: the uncommitted tree, while there is one, the whole branch
 * since it forked, and the history a commit at a time. Reads only, as the desktop's repo view does.
 */
@Composable
fun ChangesScreen(key: SessionKey, back: () -> Unit) {
    val store = LocalStore.current
    val busy = store.items[key]?.busy == true
    val connected = store.serverState[key.server] == ConnState.Connected
    var tab by remember { mutableStateOf(ChangesTab.Branch) }
    var dirty by remember { mutableStateOf(false) }
    // `work_status` has been asked once. Until then no list reads, so the screen never draws
    // Branch's files only to jump to Uncommitted.
    var known by remember { mutableStateOf(false) }
    // Pages stay composed under the one on top, so going back finds a list as it was left.
    var pages by remember { mutableStateOf(listOf<ChangesPage>()) }
    fun push(p: ChangesPage) { pages = pages + p }
    BackHandler(pages.isNotEmpty()) { pages = pages.dropLast(1) }

    /** Whether the tree holds uncommitted work: Uncommitted shows, and leads, only then. A failed read changes nothing. */
    suspend fun readDirty() {
        val cwd = store.items[key]?.cwd ?: return
        val status = runCatching { decodeOrNull<WorkStatus>(store.call(key.server, "work_status", jsonOf("cwd" to cwd))) }
            .getOrElse { if (it is CancellationException) throw it else null }
        if (status != null) {
            dirty = (status.dirty ?: 0) > 0
            if (!known && dirty) tab = ChangesTab.Uncommitted else if (tab == ChangesTab.Uncommitted && !dirty) tab = ChangesTab.Branch
        }
        known = true
    }
    // Re-asked as each turn starts and ends, since a turn is what dirties or commits the tree,
    // and on reconnect, since a read that failed with the socket down said nothing.
    LaunchedEffect(busy, connected) { readDirty() }

    Box(Modifier.fillMaxSize().background(Dray.page)) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Bar("Changes", back)
            Segments((if (dirty) listOf(ChangesTab.Uncommitted) else emptyList()) + listOf(ChangesTab.Branch, ChangesTab.Commits), tab) { tab = it }
            Box(Modifier.weight(1f)) {
                if (known) when (tab) {
                    ChangesTab.Uncommitted -> ChangeList(
                        key, reload = "work|$busy", refreshed = ::readDirty,
                        nothing = "Not a repository" to "This folder isn't tracked by git.",
                        clean = "Nothing uncommitted" to "The working tree matches the last commit.",
                        open = { set, f -> push(ChangesPage.Diff(set.base, set.head, f)) },
                    ) { cwd ->
                        val tree = store.call(key.server, "head_tree", jsonOf("cwd" to cwd)).str ?: return@ChangeList null
                        decodeOrNull<ChangeSet>(store.call(key.server, "changes_since", jsonOf("cwd" to cwd, "baseline" to tree, "head" to null)))
                    }
                    ChangesTab.Branch -> ChangeList(
                        key, reload = "branch|$busy", refreshed = ::readDirty,
                        nothing = "No commits on this branch" to "Committed work since the branch forked shows here.",
                        clean = "No changes" to "This branch's commits add up to no change.",
                        open = { set, f -> push(ChangesPage.Diff(set.base, set.head, f)) },
                    ) { cwd ->
                        val commits = branchCommits(store, key, cwd)
                        val newest = commits.firstOrNull() ?: return@ChangeList null
                        val oldest = commits.last()
                        decodeOrNull<ChangeSet>(store.call(key.server, "changes_since",
                            jsonOf("cwd" to cwd, "baseline" to oldest.base, "head" to newest.sha)))
                    }
                    ChangesTab.Commits -> CommitList(key, reload = "$busy", refreshed = ::readDirty) { push(ChangesPage.OneCommit(it)) }
                }
            }
        }
        for (page in pages) {
            // Opaque and touch-tight, so the page under it neither shows nor answers.
            Box(Modifier.fillMaxSize().background(Dray.page).pointerInput(Unit) {
                awaitPointerEventScope { while (true) awaitPointerEvent() }
            }) {
                Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                    val pop = { pages = pages.dropLast(1) }
                    when (page) {
                        is ChangesPage.OneCommit -> CommitPage(key, page.commit, pop) { set, f -> push(ChangesPage.Diff(set.base, set.head, f)) }
                        is ChangesPage.Diff -> DiffPage(key, page.base, page.head, page.file, pop)
                    }
                }
            }
        }
    }
}

/** Every commit the branch made since it forked, newest first. */
private suspend fun branchCommits(store: Store, key: SessionKey, cwd: String): List<Commit> {
    val all = mutableListOf<Commit>()
    while (true) {
        val page = decodeList<Commit>(store.call(key.server, "log_branch_commits", jsonOf("cwd" to cwd, "limit" to 200, "skip" to all.size)))
        all += page
        if (page.size < 200) return all
    }
}

@Composable
private fun Bar(title: String, back: () -> Unit, trailing: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().height(56.dp).padding(end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Dray.text) }
        Text(title, Modifier.weight(1f), style = Dray.Font.headline, maxLines = 1, overflow = TextOverflow.Ellipsis)
        trailing()
    }
}

/** The iOS segmented control: a raised track, the pick on a lighter thumb. */
@Composable
private fun Segments(tabs: List<ChangesTab>, picked: ChangesTab, pick: (ChangesTab) -> Unit) {
    Row(
        Modifier.padding(horizontal = Dray.Space.l, vertical = Dray.Space.s).fillMaxWidth().height(36.dp)
            .clip(RoundedCornerShape(Dray.Radius.sm)).background(Dray.raised).padding(2.dp),
    ) {
        for (t in tabs) {
            val on = t == picked
            Box(
                Modifier.weight(1f).fillMaxSize().clip(RoundedCornerShape(Dray.Radius.sm - 2.dp))
                    .background(if (on) Dray.tile else Color.Transparent).clickable { pick(t) },
                contentAlignment = Alignment.Center,
            ) {
                Text(t.label, style = (if (on) Dray.Font.footnoteStrong else Dray.Font.footnote).copy(color = if (on) Dray.text else Dray.secondary))
            }
        }
    }
}

/**
 * A change set's files, each opening its diff. [read] answers null where there is nothing to
 * compare, which draws [nothing]; an empty set draws [clean].
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChangeList(
    key: SessionKey,
    /** Changes when the answer may have: a turn ending, the reader switching tabs. */
    reload: String,
    /** Run beside a pull-to-refresh: the screen's own status check. */
    refreshed: suspend () -> Unit = {},
    nothing: Pair<String, String>,
    clean: Pair<String, String>,
    note: String? = null,
    open: (ChangeSet, ChangedFile) -> Unit,
    read: suspend (String) -> ChangeSet?,
) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    var changes by remember { mutableStateOf<ChangeSet?>(null) }
    var none by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    // Only the newest read may land: a mid-turn read finishing after the turn's last one would put stale files back.
    var generation by remember { mutableIntStateOf(0) }

    suspend fun load() {
        val cwd = store.items[key]?.cwd ?: return
        val mine = ++generation
        try {
            val next = read(cwd)
            if (mine != generation) return
            changes = next
            none = next == null
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (mine != generation) return
            error = e.message ?: "Failed"
        }
        loaded = true
    }
    fun refresh() {
        refreshing = true
        scope.launch {
            try { refreshed(); load() } finally { refreshing = false }
        }
    }
    LaunchedEffect(reload) { load() }

    val err = error
    val set = changes
    when {
        err != null && set == null -> Message(Icons.Outlined.WarningAmber, "Couldn't read changes", sentence(err), "Try again") { scope.launch { load() } }
        !loaded -> Loading()
        else -> PullToRefreshBox(refreshing, ::refresh, Modifier.fillMaxSize()) {
            if (none || set == null || (set.files.isEmpty() && note == null)) {
                val (title, message) = if (none || set == null) nothing else clean
                // Scrolls only so a pull can refresh it.
                BoxWithConstraints(Modifier.fillMaxSize()) {
                    val tall = maxHeight
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                        err?.let { RefreshFailed(it, Modifier.padding(Dray.Space.l)) { refresh() } }
                        Box(Modifier.fillMaxWidth().height(tall)) { Message(Icons.Outlined.Difference, title, message) }
                    }
                }
            } else {
                Files(set, note, err, ::refresh) { open(set, it) }
            }
        }
    }
}

/** One group per folder, the folder's glyph and path over its files: root files first, then folders by path. */
@Composable
private fun Files(set: ChangeSet, note: String?, error: String?, retry: () -> Unit, open: (ChangedFile) -> Unit) {
    val byDir = remember(set) { set.files.groupBy { splitPath(it.path).first } }
    val dirs = remember(byDir) { byDir.keys.sortedWith(compareBy<String>({ it.isNotEmpty() }, { it })) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Dray.Space.l, end = Dray.Space.l, top = Dray.Space.s, bottom = Dray.Space.xxl)) {
        error?.let { e -> item("error") { RefreshFailed(e, Modifier.padding(bottom = Dray.Space.m), retry) } }
        item("summary") { Summary(set, note) }
        // A commit that changed no files still says what it was.
        if (dirs.isEmpty()) item("none") {
            Text("No file changes", Modifier.fillMaxWidth().padding(top = Dray.Space.m).clip(RoundedCornerShape(Dray.Radius.lg))
                .background(Dray.card).padding(16.dp), style = Dray.Font.body.copy(color = Dray.tertiary))
        }
        for (dir in dirs) {
            item("dir-$dir") {
                Row(
                    Modifier.padding(top = 20.dp, bottom = Dray.Space.s, start = Dray.Space.xs),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dray.Space.s),
                ) {
                    if (dir.isNotEmpty()) {
                        FileIcon(dir, folder = true)
                        Truncated(dir, Dray.Font.footnote.copy(color = Dray.secondary), head = true)
                    }
                }
            }
            group(byDir[dir].orEmpty(), { "file-${it.path}" }) { f -> FileRow(f) { open(f) } }
        }
    }
}

/** Rows drawn as one rounded card, hairlines between them, as an inset grouped list. */
private fun <T> LazyListScope.group(rows: List<T>, key: (T) -> String, row: @Composable (T) -> Unit) {
    itemsIndexed(rows, key = { _, r -> key(r) }) { i, r ->
        val top = if (i == 0) Dray.Radius.lg else 0.dp
        val bottom = if (i == rows.lastIndex) Dray.Radius.lg else 0.dp
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(top, top, bottom, bottom)).background(Dray.card)) {
            row(r)
            if (i < rows.lastIndex) Box(Modifier.padding(start = 44.dp).fillMaxWidth().height(1.dp).background(Dray.hairline))
        }
    }
}

@Composable
private fun Summary(set: ChangeSet, note: String?) {
    Column(Modifier.padding(horizontal = Dray.Space.xs), verticalArrangement = Arrangement.spacedBy(Dray.Space.s)) {
        note?.let { SelectionContainer { Text(it, style = Dray.Font.subhead) } }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("${set.files.size} ${if (set.files.size == 1) "file" else "files"}", style = Dray.Font.footnote.copy(color = Dray.secondary))
            Counts(set.added, set.removed)
        }
    }
}

/** A refresh that failed over rows already shown: they stay, and this says they may be old. */
@Composable
private fun RefreshFailed(error: String, modifier: Modifier = Modifier, retry: () -> Unit) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Dray.Space.m), verticalAlignment = Alignment.CenterVertically) {
        Text("Couldn't refresh: ${sentence(error)}", Modifier.weight(1f), style = Dray.Font.footnote.copy(color = Dray.destructive))
        Text("Try again", Modifier.clickable(onClick = retry).padding(4.dp), style = Dray.Font.footnoteStrong)
    }
}

@Composable
private fun Counts(added: Int, removed: Int, style: TextStyle = Dray.Font.footnote) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("+$added", style = style.copy(color = Dray.add, fontFeatureSettings = "tnum"))
        Text("−$removed", style = style.copy(color = Dray.destructive, fontFeatureSettings = "tnum"))
    }
}

/** A file's type glyph and name, its counts at the end. Its folder is the group's header. */
@Composable
private fun FileRow(file: ChangedFile, open: () -> Unit) {
    val deleted = file.status == "deleted"
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClick = open).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dray.Space.m),
    ) {
        FileIcon(file.path)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Truncated(
                splitPath(file.path).second,
                Dray.Font.body.copy(color = if (deleted) Dray.secondary else Dray.text, textDecoration = if (deleted) TextDecoration.LineThrough else null),
            )
            file.oldPath?.let { Truncated("from $it", Dray.Font.footnote.copy(color = Dray.tertiary), head = true) }
        }
        when {
            file.binary -> Text("binary", style = Dray.Font.footnote.copy(color = Dray.tertiary))
            file.status == "added" && file.removed == 0 -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("new", style = Dray.Font.footnote.copy(color = Dray.tertiary))
                Counts(file.added, 0)
            }
            else -> Counts(file.added, file.removed)
        }
        Chevron(false)
    }
}

/**
 * One line cut to fit with an ellipsis in the middle, or at the head where the end is what
 * matters (a folder's path). Compose here has only a trailing ellipsis.
 */
@Composable
private fun Truncated(text: String, style: TextStyle, modifier: Modifier = Modifier, head: Boolean = false) {
    val measurer = rememberTextMeasurer()
    BoxWithConstraints(modifier) {
        val max = constraints.maxWidth
        val shown = remember(text, style, max) {
            fun fits(s: String) = measurer.measure(s, style, maxLines = 1, softWrap = false).size.width <= max
            if (max == Int.MAX_VALUE || fits(text)) return@remember text
            fun cut(keep: Int) = if (head) "…" + text.takeLast(keep)
            else text.take((keep + 1) / 2) + "…" + text.takeLast(keep / 2)
            var lo = 0
            var hi = text.length
            while (lo < hi) {
                val mid = (lo + hi + 1) / 2
                if (fits(cut(mid))) lo = mid else hi = mid - 1
            }
            cut(lo)
        }
        Text(shown, style = style, maxLines = 1, softWrap = false)
    }
}

/** An SF-symbol-sized glyph, a title and a sentence, centred, with one optional action. */
@Composable
private fun Message(
    icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, message: String,
    action: String? = null, onAction: () -> Unit = {},
) {
    Column(
        Modifier.fillMaxSize().padding(horizontal = 40.dp).padding(bottom = 80.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, null, Modifier.size(32.dp), tint = Dray.tertiary)
        Spacer(Modifier.height(14.dp))
        Text(title, style = Dray.Font.title, textAlign = TextAlign.Center)
        if (message.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Text(message, Modifier.widthIn(max = 300.dp), style = Dray.Font.subhead.copy(color = Dray.secondary), textAlign = TextAlign.Center)
        }
        action?.let {
            Spacer(Modifier.height(20.dp))
            Text(it, Modifier.clip(CircleShape).background(Dray.raised).clickable(onClick = onAction).padding(horizontal = 18.dp, vertical = 10.dp), style = Dray.Font.pill)
        }
    }
}

@Composable
private fun Loading() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(Modifier.size(24.dp), color = Dray.secondary, strokeWidth = 2.dp)
    }
}

/** The history, a page at a time; a commit opens its own changes. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CommitList(key: SessionKey, reload: String, refreshed: suspend () -> Unit, open: (Commit) -> Unit) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    var commits by remember { mutableStateOf(listOf<Commit>()) }
    var more by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var paging by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    // A refresh asked for while a read was out, run once it lands.
    var resetQueued by remember { mutableStateOf(false) }
    val page = 50

    suspend fun load(reset: Boolean) {
        val cwd = store.items[key]?.cwd ?: return
        // One read at a time. A refresh arriving meanwhile waits its turn rather than being
        // dropped: a commit landing during Load more would otherwise never show.
        if (paging) {
            if (reset) resetQueued = true
            return
        }
        paging = true
        try {
            val next = decodeList<Commit>(store.call(key.server, "log_commits",
                jsonOf("cwd" to cwd, "limit" to page, "skip" to if (reset) 0 else commits.size)))
            // A page read against the old tip may overlap the new one; the queued refresh replaces it.
            if (!resetQueued) {
                if (reset) {
                    // A refresh keeps the pages read below an unchanged tip, as `reconcileLog` does.
                    if (commits.firstOrNull()?.sha != next.firstOrNull()?.sha) { commits = next; more = next.size == page }
                } else {
                    commits = commits + next
                    more = next.size == page
                }
                error = null
            }
        } catch (e: CancellationException) {
            paging = false
            throw e
        } catch (e: Exception) {
            error = e.message ?: "Failed"
        }
        loaded = true
        paging = false
        if (resetQueued) {
            resetQueued = false
            load(true)
        }
    }
    LaunchedEffect(reload) { load(true) }

    val err = error
    when {
        err != null && commits.isEmpty() -> Message(Icons.Outlined.WarningAmber, "Couldn't read history", sentence(err), "Try again") { scope.launch { load(true) } }
        !loaded -> Loading()
        commits.isEmpty() -> Message(Icons.Outlined.Commit, "No commits yet", "This branch has nothing committed.")
        else -> PullToRefreshBox(refreshing, {
            refreshing = true
            scope.launch { try { refreshed(); load(true) } finally { refreshing = false } }
        }, Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Dray.Space.l, end = Dray.Space.l, top = Dray.Space.s, bottom = Dray.Space.xxl)) {
                err?.let { e -> item("error") { RefreshFailed(e, Modifier.padding(bottom = Dray.Space.m)) { scope.launch { load(true) } } } }
                val rows: List<Commit?> = commits + if (more) listOf(null) else emptyList()
                group(rows, { it?.sha ?: "more" }) { c ->
                    if (c != null) CommitRow(c) { open(c) }
                    else Box(Modifier.fillMaxWidth().height(48.dp).clickable(enabled = !paging) { scope.launch { load(false) } }, contentAlignment = Alignment.Center) {
                        if (paging) CircularProgressIndicator(Modifier.size(18.dp), color = Dray.secondary, strokeWidth = 2.dp)
                        else Text("Load more", style = Dray.Font.body.copy(color = Dray.link))
                    }
                }
            }
        }
    }
}

@Composable
private fun CommitRow(commit: Commit, open: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = open).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(commit.subject, style = Dray.Font.body, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val meta = Dray.Font.footnote.copy(color = Dray.tertiary)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(commit.author, Modifier.weight(1f, fill = false), style = meta, maxLines = 1, overflow = TextOverflow.Ellipsis)
                parseDate(commit.authoredAt)?.let { Text("· ${shortAge(it)}", style = meta, maxLines = 1) }
                Text("· ${commit.sha.take(7)}", style = meta.copy(fontFamily = Dray.Font.code.fontFamily), maxLines = 1)
            }
        }
        Chevron(false)
    }
}

/** One commit's own changes, its message on top. */
@Composable
private fun CommitPage(key: SessionKey, commit: Commit, back: () -> Unit, open: (ChangeSet, ChangedFile) -> Unit) {
    val store = LocalStore.current
    val message = if (commit.body.isEmpty()) commit.subject else "${commit.subject}\n\n${commit.body}"
    Bar(commit.sha.take(7), back)
    ChangeList(
        key, reload = commit.sha,
        nothing = "Nothing to compare" to "",
        clean = "No file changes" to "This commit changed no files.",
        note = message, open = open,
    ) { cwd ->
        decodeOrNull<ChangeSet>(store.call(key.server, "changes_since", jsonOf("cwd" to cwd, "baseline" to commit.base, "head" to commit.sha)))
    }
}

/** One file's change as a unified diff: lines wrap rather than scroll sideways. */
@Composable
private fun DiffPage(key: SessionKey, base: String, head: String, file: ChangedFile, back: () -> Unit) {
    val store = LocalStore.current
    var rows by remember { mutableStateOf<List<DiffRow>?>(null) }
    var withheld by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(file, base, head) {
        if (file.binary) return@LaunchedEffect
        val cwd = store.items[key]?.cwd ?: return@LaunchedEffect
        try {
            val v = decodeOrNull<FileVersions>(store.call(key.server, "file_change", jsonOf(
                "cwd" to cwd, "base" to base, "head" to head, "path" to file.path, "oldPath" to file.oldPath,
            ))) ?: FileVersions()
            if (v.unreadable != null) { withheld = v.unreadable; return@LaunchedEffect }
            // Off the main thread: a long file's difference takes a moment.
            rows = withContext(Dispatchers.Default) { unifiedDiff(v.oldText, v.newText) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: "Failed"
        }
    }
    Bar(splitPath(file.path).second, back) { Counts(file.added, file.removed) }
    val r = rows
    val w = withheld
    when {
        file.binary -> Message(Icons.Outlined.Description, "Binary file", "There are no lines to compare.")
        w != null -> Message(Icons.Outlined.Description, if (w == "binary") "Binary file" else "Too large to show",
            if (w == "binary") "There are no lines to compare." else "One side is over 1 MB.")
        error != null -> Message(Icons.Outlined.Description, "Couldn't read this file", sentence(error!!))
        r != null && r.isEmpty() -> Message(Icons.Outlined.Description, "No line changes", "Only the file's mode or name changed.")
        r != null -> Lines(file, r)
        else -> Loading()
    }
}

@Composable
private fun Lines(file: ChangedFile, rows: List<DiffRow>) {
    val digits = remember(rows) { rows.maxOfOrNull { (it as? DiffRow.Line)?.number ?: 0 }?.toString()?.length ?: 1 }
    SelectionContainer {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Dray.Space.s, end = Dray.Space.s, top = Dray.Space.xs, bottom = Dray.Space.xxl)) {
            item("path") {
                Row(Modifier.padding(start = Dray.Space.s, end = Dray.Space.s, bottom = Dray.Space.m), horizontalArrangement = Arrangement.spacedBy(Dray.Space.s), verticalAlignment = Alignment.CenterVertically) {
                    FileIcon(file.path)
                    Text(file.oldPath?.let { "$it → ${file.path}" } ?: file.path, style = Dray.Font.footnote.copy(color = Dray.tertiary))
                }
            }
            itemsIndexed(rows) { i, row ->
                val top = if (i == 0) Dray.Radius.md else 0.dp
                val bottom = if (i == rows.lastIndex) Dray.Radius.md else 0.dp
                Box(Modifier.clip(RoundedCornerShape(top, top, bottom, bottom)).background(Dray.well)
                    .padding(top = if (i == 0) 4.dp else 0.dp, bottom = if (i == rows.lastIndex) 4.dp else 0.dp)) {
                    DiffLine(row, digits)
                }
            }
        }
    }
}

@Composable
private fun DiffLine(row: DiffRow, digits: Int) {
    when (row) {
        is DiffRow.Gap -> Text(
            "⋯ ${row.count} unchanged ${if (row.count == 1) "line" else "lines"}",
            Modifier.fillMaxWidth().background(Dray.card).padding(horizontal = Dray.Space.m, vertical = 6.dp),
            style = Dray.Font.footnote.copy(color = Dray.tertiary),
        )
        DiffRow.NoNewline -> Text(
            "No newline at end of file",
            Modifier.fillMaxWidth().padding(horizontal = Dray.Space.m, vertical = 2.dp),
            style = Dray.Font.footnote.copy(color = Dray.tertiary),
        )
        is DiffRow.Line -> {
            val tint = when (row.sign) { '+' -> Dray.add; '-' -> Dray.destructive; else -> Color.Transparent }
            Row(
                Modifier.fillMaxWidth().background(tint.copy(alpha = if (row.sign == ' ') 0f else 0.14f)).padding(horizontal = Dray.Space.s, vertical = 1.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                val code = Dray.Font.code
                // A template of the widest number holds the gutter steady at any text size.
                Box(contentAlignment = Alignment.TopEnd) {
                    Text("0".repeat(digits), Modifier.alpha(0f), style = code)
                    Text(row.number.toString(), style = code.copy(color = Dray.tertiary))
                }
                Text(row.sign.toString(), style = code.copy(color = if (row.sign == ' ') Dray.tertiary else tint))
                // A CRLF line keeps its CR to diff against LF, but drawn it breaks the line.
                val shown = row.text.removeSuffix("\r")
                Text(shown.ifEmpty { " " }, Modifier.weight(1f), style = code)
            }
        }
    }
}

/**
 * The desktop's `FileIcon`: the Material glyph for a file's type or a folder's name, full colour,
 * from the set `scripts/file_icons.py` copies into assets.
 */
@Composable
fun FileIcon(path: String, folder: Boolean = false, size: Dp = 16.dp) {
    val context = LocalContext.current
    val svg = remember(path, folder) { FileIcons.svg(context, FileIcons.name(context, path, folder)) }
    Canvas(Modifier.size(size)) {
        svg ?: return@Canvas
        drawIntoCanvas { c ->
            svg.renderToCanvas(c.nativeCanvas, RenderOptions().viewPort(0f, 0f, this.size.width, this.size.height))
        }
    }
}

/** The lookup and every icon parsed, once each, for the app's life. */
private object FileIcons {
    @Volatile private var map: FileIconMap? = null
    private val parsed = ConcurrentHashMap<String, SVG>()

    fun name(context: Context, path: String, folder: Boolean): String {
        val m = map ?: runCatching {
            FileIconMap.parse(context.assets.open("file-icons.json").bufferedReader().readText())
        }.getOrNull()?.also { map = it } ?: return if (folder) "folder" else "file"
        return m.name(path, folder)
    }

    fun svg(context: Context, name: String): SVG? = parsed[name] ?: runCatching {
        SVG.getFromAsset(context.assets, "file-icons/$name.svg")
    }.getOrNull()?.also { parsed[name] = it }
}
