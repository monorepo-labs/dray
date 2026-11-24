package com.yogesh.dray.ui

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.Integrations
import com.yogesh.dray.model.Issue
import com.yogesh.dray.model.TrackerLabel
import com.yogesh.dray.model.issueGroups
import com.yogesh.dray.model.matches
import com.yogesh.dray.model.priorityLabels
import com.yogesh.dray.model.trackerColor
import com.yogesh.dray.store.IssueQuery
import com.yogesh.dray.store.trackerServer
import com.yogesh.dray.wire.bool
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.parseDate
import com.yogesh.dray.wire.shortAge
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Issues.swift's page: every issue the reader could pick up, GitHub's or Linear's.

/** The page's picks that outlive it, as iOS keeps them in its app storage. */
private class IssuesPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("store", Context.MODE_PRIVATE)
    var tracker by mutableStateOf(prefs.getString("issues.tracker", "linear")!!)
    var repo by mutableStateOf(prefs.getString("issues.repo", "").orEmpty())
    var linearScope by mutableStateOf(prefs.getString("issues.linearScope", "assigned")!!)
    var githubScope by mutableStateOf(prefs.getString("issues.githubScope", "assigned")!!)

    fun save() = prefs.edit().putString("issues.tracker", tracker).putString("issues.repo", repo)
        .putString("issues.linearScope", linearScope).putString("issues.githubScope", githubScope).apply()
}

/**
 * The desktop's issues page on a phone. The tracker switch leads; whose issues are chips under
 * it, then the search box; repository, team, project, type and label sit behind the filter
 * button. A row opens the issue. Draws the last answer for the picks at once, from disk on a
 * fresh launch, and reads behind it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IssuesScreen(back: () -> Unit, open: (server: String, issue: Issue) -> Unit) {
    val store = LocalStore.current
    val model = store.issues
    val context = LocalContext.current
    val picks = remember { IssuesPrefs(context) }
    var closed by rememberSaveable { mutableStateOf(false) }
    var team by rememberSaveable { mutableStateOf<String?>(null) }
    var project by rememberSaveable { mutableStateOf<String?>(null) }
    var label by rememberSaveable { mutableStateOf<String?>(null) }
    var issueType by rememberSaveable { mutableStateOf<String?>(null) }
    var text by rememberSaveable { mutableStateOf("") }
    var searching by rememberSaveable { mutableStateOf(false) }
    var settledOpen by rememberSaveable { mutableStateOf(false) }
    var filtering by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val github = picks.tracker == "github"
    val scopePick = if (github) picks.githubScope else picks.linearScope
    val live = store.trackerServer
    // Before any server is up, the last one read through stands in, so its answers draw.
    val server = live ?: model.home
    val integrations = server?.let { model.integrations[it] }
    val connected = integrations?.let { if (github) it.github != null else it.linear != null }
    val q = server?.let { IssueQuery(it, picks.tracker, scopePick, github && closed, picks.repo, team, project, label, issueType, text.trim()) }
    val filters = server?.let { model.filters[model.filtersKey(it, picks.tracker, picks.repo)] }
    val list = q?.let { model.lists[it.key] ?: if (it.text.isNotEmpty()) model.lists[it.unsearched.key]?.filter { i -> i.matches(it.text) } else null }
    val error = q?.let { model.errors[it.key] }

    LaunchedEffect(live) { live?.let { model.readIntegrations(it) } }
    LaunchedEffect(live, picks.tracker, picks.repo, connected) {
        if (live != null && connected == true) model.readFilters(live, picks.tracker, picks.repo)
    }
    // Typing waits a beat, so a word is one read rather than one per letter.
    LaunchedEffect(q?.key, live, connected) {
        if (live == null || q == null || connected != true || (github && picks.repo.isEmpty())) return@LaunchedEffect
        if (q.text.isNotEmpty()) delay(350)
        model.list(q, force = false, withSettled = settledOpen && !github)
    }

    Column(Modifier.fillMaxSize().background(Dray.page).statusBarsPadding().navigationBarsPadding()) {
        Bar("Issues", back) {
            if (model.loading > 0 && list != null) {
                CircularProgressIndicator(Modifier.padding(end = 8.dp).size(16.dp), color = Dray.tertiary, strokeWidth = 2.dp)
            }
            if (connected == true) SearchButton(searching) { searching = true }
            // Always there once a server is: the tracker switch lives behind it.
            if (server != null) {
                val any = if (github) picks.repo.isNotEmpty() && (label != null || issueType != null) else team != null || project != null
                IconButton({ filtering = true }) {
                    Icon(if (any) Icons.Filled.FilterList else Icons.Outlined.FilterList, "Filters", tint = if (any) Dray.text else Dray.secondary)
                }
            }
        }
        if (searching) SearchField(text, "Search issues", close = { text = ""; searching = false }) { text = it }
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch {
                    live?.let { s ->
                        if (integrations == null) model.readIntegrations(s)
                        if (q != null && !(github && picks.repo.isEmpty())) model.list(q, force = true, withSettled = settledOpen && !github)
                    }
                    refreshing = false
                }
            },
            modifier = Modifier.weight(1f),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 40.dp)) {
                when {
                    server == null && store.live.isEmpty() -> item("no-server") { Note("Connect a server to read its issue trackers.") }
                    server == null -> item("waiting") { Reading("Waiting for a server…") }
                    connected == false -> item("connect") {
                        ConnectTracker(picks.tracker, server!!) { model.connected(server, it) }
                    }
                    connected == null -> item("no-integrations") {
                        if (model.integrationsFailed[server!!] == true) Note("Could not read which trackers ${store.name(server)} is connected to. Pull down to try again.")
                        else Reading()
                    }
                    else -> {
                        item("scopes") {
                            Box(Modifier.padding(horizontal = Dray.Space.l, vertical = Dray.Space.s)) {
                                val options = if (github) listOf("assigned" to "Assigned to me", "all" to "All") else listOf("assigned" to "Assigned to me", "created" to "Created")
                                ChipRow {
                                    items(options.size) { i ->
                                        val (value, title) = options[i]
                                        PickChip(title, scopePick == value) {
                                            if (github) picks.githubScope = value else picks.linearScope = value
                                            picks.save()
                                        }
                                    }
                                    if (github) {
                                        item { Box(Modifier.padding(horizontal = Dray.Space.xs, vertical = 8.dp).width(1.dp).height(20.dp).background(Dray.tile)) }
                                        item { PickChip("Open", !closed) { closed = false } }
                                        item { PickChip("Closed", closed) { closed = true } }
                                    }
                                }
                            }
                        }
                        content(github, picks, filters, q!!, list, error, text, closed, scopePick, settledOpen,
                            pickRepo = { picks.repo = it; picks.save() },
                            toggleSettled = {
                                settledOpen = !settledOpen
                                if (settledOpen && model.settled[q.key] == null && live != null) scope.launch { model.listSettled(q) }
                            },
                            settled = model.settled[q.key],
                        ) { open(server!!, it) }
                    }
                }
            }
        }
    }

    if (filtering) {
        ModalBottomSheet({ filtering = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Dray.card) {
            PickSheet("Filters", done = { filtering = false }) {
                PickCard {
                    val trackers = listOf("github" to "GitHub", "linear" to "Linear")
                    PickMenu("Tracker", trackers.first { it.first == picks.tracker }.second, trackers, picks.tracker, pick = { picks.tracker = it; picks.save() })
                    if (connected == true && filters != null) {
                        PickDivider()
                        if (github) {
                            val repos = filters.teams
                            if (repos.isNotEmpty()) {
                                PickMenu("Repository", repos.firstOrNull { it.id == picks.repo }?.name ?: "Choose", repos.map { it.id to it.name }, picks.repo, pick = {
                                    picks.repo = it; picks.save(); label = null; issueType = null
                                })
                            }
                            if (filters.issueTypes.isNotEmpty()) {
                                PickDivider()
                                PickMenu("Type", issueType ?: "Any type", listOf<Pair<String?, String>>(null to "Any type") + filters.issueTypes.map { it.name to it.name }, issueType, pick = { issueType = it })
                            }
                            if (filters.labels.isNotEmpty()) {
                                PickDivider()
                                PickMenu("Label", label ?: "Any label", listOf<Pair<String?, String>>(null to "Any label") + filters.labels.map { it.name to it.name }, label, pick = { label = it })
                            }
                        } else {
                            PickMenu("Team", filters.teams.firstOrNull { it.id == team }?.name ?: "All teams",
                                listOf<Pair<String?, String>>(null to "All teams") + filters.teams.map { it.id to it.name }, team, pick = { team = it })
                            if (filters.projects.isNotEmpty()) {
                                PickDivider()
                                PickMenu("Project", filters.projects.firstOrNull { it.id == project }?.name ?: "All projects",
                                    listOf<Pair<String?, String>>(null to "All projects") + filters.projects.map { it.id to it.name }, project, pick = { project = it })
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun LazyListScope.content(
    github: Boolean, picks: IssuesPrefs, filters: com.yogesh.dray.model.IssueFilters?, q: IssueQuery, list: List<Issue>?,
    error: com.yogesh.dray.model.IssueUnavailable?, text: String, closed: Boolean, scope: String, settledOpen: Boolean,
    pickRepo: (String) -> Unit, toggleSettled: () -> Unit, settled: List<Issue>?, open: (Issue) -> Unit,
) {
    error?.let { e ->
        item("error") { Text(inlineMarkdown(e.sentence(q.tracker)), Modifier.padding(horizontal = 20.dp, vertical = 4.dp), style = Dray.Font.footnote.copy(color = Dray.destructive)) }
    }
    if (github && picks.repo.isEmpty()) {
        // Nothing is read until a repository is picked: the repositories are the empty state.
        when {
            filters == null -> item("reading") { Reading() }
            filters.teams.isEmpty() -> item("no-repos") { Note("Attach a project with a GitHub remote to see its issues.") }
            else -> {
                item("choose") { Note("Choose a repository to see its issues.") }
                for (r in filters.teams) item("repo-${r.id}") {
                    Row(
                        Modifier.fillMaxWidth().height(48.dp).clickable { pickRepo(r.id) }.padding(horizontal = 20.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dray.Space.s),
                    ) {
                        Icon(Icons.AutoMirrored.Outlined.MenuBook, null, Modifier.size(18.dp), tint = Dray.tertiary)
                        Text(r.name, Modifier.weight(1f), style = Dray.Font.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        return
    }
    val scopeAll = scope != "assigned"
    when {
        list == null && error == null -> item("reading") { Reading() }
        list.isNullOrEmpty() && list != null -> item("empty") {
            Note(if (text.isNotBlank()) "No issue matches that." else when {
                closed -> if (scope == "all") "No closed issues in this repository." else "Nothing closed is assigned to you."
                scope == "created" -> "Nothing you filed is open."
                scope == "all" -> "No open issues in this repository."
                else -> "Nothing assigned to you."
            })
        }
        list == null -> {}
        github -> for (i in list) item("i-${i.id}") { IssueRowView(i, scopeAll) { open(i) } }
        else -> grouped("open", list, scopeAll, open)
    }
    // Done and Cancelled are Linear's, start closed, and are read only once opened.
    if (!github && list != null) {
        item("settled-toggle") {
            Row(
                Modifier.padding(start = 20.dp, top = Dray.Space.l).height(32.dp).clickable(onClick = toggleSettled),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("Done and cancelled", style = Dray.Font.footnote.copy(color = Dray.tertiary))
                Icon(if (settledOpen) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(16.dp), tint = Dray.tertiary)
            }
        }
        if (settledOpen) {
            when {
                settled == null -> item("settled-reading") { Reading() }
                settled.isEmpty() -> item("settled-none") { Note("Nothing here.") }
                else -> grouped("settled", settled, scopeAll, open)
            }
        }
    }
}

private fun LazyListScope.grouped(prefix: String, list: List<Issue>, showAssignee: Boolean, open: (Issue) -> Unit) {
    for ((kind, title) in issueGroups) {
        val rows = list.filter { it.state.kind == kind }
        if (rows.isEmpty()) continue
        item("$prefix-h-$kind") {
            Row(Modifier.padding(start = 20.dp, top = Dray.Space.l, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                IssueStateGlyph(kind, null)
                Text(title, style = Dray.Font.footnote.copy(color = Dray.tertiary))
                Text("${rows.size}", style = Dray.Font.footnote.copy(color = Dray.dim))
            }
        }
        for (i in rows) item("$prefix-i-${i.id}") { IssueRowView(i, showAssignee) { open(i) } }
    }
}

/** One issue: its state, its title over its number, priority, labels and people. */
@Composable
private fun IssueRowView(issue: Issue, showAssignee: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onClick).padding(start = 20.dp, end = 16.dp, top = 10.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.padding(top = 3.dp)) { IssueStateGlyph(issue.state.kind, issue.state.color) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(issue.title, style = Dray.Font.body.copy(color = Dray.text.copy(alpha = 0.88f)), maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                val foot = Dray.Font.footnote.copy(color = Dray.tertiary)
                Text(issue.short, style = foot, maxLines = 1)
                if (issue.tracker == "linear" && issue.priority != "none") PriorityGlyph(issue.priority)
                issue.issueType?.let { LabelDot(it) }
                for (l in issue.labels.take(2)) LabelDot(l)
                if (issue.pullRequests.isNotEmpty()) Text(issue.pullRequests.joinToString(" ") { "#$it" }.let { "PR $it" }, style = foot, maxLines = 1)
            }
        }
        // Whose it is sits under when it last moved, at the row's edge, as on a PR row.
        Column(Modifier.padding(top = 3.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            parseDate(issue.updatedAt)?.let { Text(shortAge(it), style = Dray.Font.footnote.copy(color = Dray.tertiary)) }
            if (showAssignee) issue.assignee?.let { Avatar(it.avatar, 18, it.name) }
        }
    }
}

/** A label as its colour's dot and its name. */
@Composable
private fun LabelDot(label: TrackerLabel) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        Box(Modifier.size(7.dp).clip(RoundedCornerShape(50)).background(Color(trackerColor(label.color))))
        Text(label.name, style = Dray.Font.footnote.copy(color = Dray.tertiary), maxLines = 1)
    }
}

private val stateFallback = mapOf(
    "triage" to "#e2a336", "backlog" to "#bec2c8", "unstarted" to "#e2e2e2", "started" to "#f2c94c",
    "completed" to "#5e6ad2", "canceled" to "#95a2b3", "other" to "#bec2c8",
)

/** Linear's status mark: a ring, part-filled with progress, filled once done or cancelled, in the tracker's own colour. */
@Composable
fun IssueStateGlyph(kind: String, color: String?, size: Dp = 14.dp) {
    val tone = Color(trackerColor(color?.takeIf { it.isNotEmpty() } ?: stateFallback[kind].orEmpty()))
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.11f
        when (kind) {
            "completed", "canceled" -> {
                drawCircle(tone)
                val mark = Stroke(w * 0.12f, cap = StrokeCap.Round)
                val ink = Color(0xFF0A0A0A)
                if (kind == "completed") {
                    drawLine(ink, Offset(w * 0.3f, w * 0.52f), Offset(w * 0.44f, w * 0.66f), mark.width, StrokeCap.Round)
                    drawLine(ink, Offset(w * 0.44f, w * 0.66f), Offset(w * 0.71f, w * 0.36f), mark.width, StrokeCap.Round)
                } else {
                    drawLine(ink, Offset(w * 0.34f, w * 0.34f), Offset(w * 0.66f, w * 0.66f), mark.width, StrokeCap.Round)
                    drawLine(ink, Offset(w * 0.66f, w * 0.34f), Offset(w * 0.34f, w * 0.66f), mark.width, StrokeCap.Round)
                }
            }
            else -> {
                drawCircle(tone, radius = (w - stroke) / 2, style = Stroke(
                    stroke, pathEffect = if (kind == "backlog") PathEffect.dashPathEffect(floatArrayOf(w * 0.14f, w * 0.11f)) else null,
                ))
                val fill = when (kind) { "triage" -> 0.25f; "started" -> 0.5f; else -> 0f }
                if (fill > 0) {
                    val inset = w * 0.25f
                    drawArc(tone, -90f, 360f * fill, useCenter = true, topLeft = Offset(inset, inset), size = Size(w - 2 * inset, w - 2 * inset))
                }
            }
        }
    }
}

/** Linear's priority: rising bars, urgent a filled square with its mark. */
@Composable
fun PriorityGlyph(priority: String, size: Dp = 13.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        if (priority == "urgent") {
            drawRoundRect(Dray.urgent, cornerRadius = androidx.compose.ui.geometry.CornerRadius(w * 0.2f))
            drawLine(Color(0xFF0A0A0A), Offset(w / 2, w * 0.22f), Offset(w / 2, w * 0.58f), w * 0.14f, StrokeCap.Round)
            drawCircle(Color(0xFF0A0A0A), w * 0.08f, Offset(w / 2, w * 0.77f))
            return@Canvas
        }
        val lit = when (priority) { "high" -> 3; "medium" -> 2; "low" -> 1; else -> 0 }
        if (lit == 0) {
            drawLine(Dray.tertiary, Offset(w * 0.2f, w / 2), Offset(w * 0.8f, w / 2), w * 0.14f, StrokeCap.Round)
            return@Canvas
        }
        val bar = w * 0.22f
        for (i in 0 until 3) {
            val h = w * (0.4f + 0.3f * i)
            drawRoundRect(
                if (i < lit) Dray.secondary else Dray.dim, Offset(i * (bar + w * 0.17f), w - h), Size(bar, h),
                androidx.compose.ui.geometry.CornerRadius(bar * 0.3f),
            )
        }
    }
}

/** A tracker with nothing behind it on the server: Linear takes a key here, GitHub a `gh auth login` there. */
@Composable
private fun ConnectTracker(tracker: String, server: String, connected: (Integrations) -> Unit) {
    val store = LocalStore.current
    val uri = LocalUriHandler.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var key by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }
    val place = store.name(server)
    Column(Modifier.padding(horizontal = 20.dp).padding(top = Dray.Space.xl), verticalArrangement = Arrangement.spacedBy(Dray.Space.m)) {
        Text(if (tracker == "linear") "Connect Linear" else "GitHub CLI is logged out", style = Dray.Font.title)
        if (tracker == "linear") {
            Text("Paste a personal API key. $place keeps it and reads Linear with it.", style = Dray.Font.subhead.copy(color = Dray.secondary))
            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.raised).padding(14.dp)) {
                if (key.isEmpty()) Text("lin_api_…", style = Dray.Font.body.copy(color = Dray.tertiary))
                BasicTextField(
                    key, { key = it }, Modifier.fillMaxWidth(), singleLine = true, textStyle = Dray.Font.body,
                    cursorBrush = SolidColor(Dray.text), visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                )
            }
            CapsuleButton(if (busy) "Connecting…" else "Connect") {
                if (busy || key.isBlank()) return@CapsuleButton
                scope.launch {
                    busy = true
                    try {
                        val next = decodeOrNull<Integrations>(store.call(server, "connect_linear", jsonOf("key" to key.trim())))
                        key = ""
                        failure = null
                        next?.let(connected)
                    } catch (e: Exception) {
                        failure = e.message ?: "Failed"
                    } finally {
                        busy = false
                    }
                }
            }
            Text("Make a key in Linear", Modifier.clickable { runCatching { uri.openUri("https://linear.app/settings/account/security") } },
                style = Dray.Font.subhead.copy(color = Dray.link))
        } else {
            Text("Issues on GitHub come from the GitHub CLI on $place. Run this there, then check again.", style = Dray.Font.subhead.copy(color = Dray.secondary))
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.raised)
                    .clickable { clipboard.setText(AnnotatedString("gh auth login")); copied = true }.padding(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("gh auth login", Modifier.weight(1f), style = Dray.Font.code)
                Icon(if (copied) Icons.Filled.Check else Icons.Outlined.ContentCopy, "Copy gh auth login", Modifier.size(18.dp), tint = Dray.secondary)
            }
            CapsuleButton(if (busy) "Checking…" else "Check again") {
                if (busy) return@CapsuleButton
                scope.launch {
                    busy = true
                    try {
                        runCatching { store.call(server, "recheck_gh").bool }
                        val next = runCatching { decodeOrNull<Integrations>(store.call(server, "get_integrations")) }.getOrNull() ?: return@launch
                        if (next.github == null) failure = "Still not signed in on $place."
                        connected(next)
                    } finally {
                        busy = false
                    }
                }
            }
        }
        failure?.let { Text(sentence(it), style = Dray.Font.footnote.copy(color = Dray.destructive)) }
    }
}
