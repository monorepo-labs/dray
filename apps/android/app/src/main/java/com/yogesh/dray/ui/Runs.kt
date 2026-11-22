package com.yogesh.dray.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.Item
import com.yogesh.dray.model.AgentRun
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.TurnPrompt
import com.yogesh.dray.model.buildRuns
import com.yogesh.dray.model.outputPath
import com.yogesh.dray.model.runItems
import com.yogesh.dray.store.Store
import com.yogesh.dray.wire.AgentEvent
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.parseDate
import com.yogesh.dray.wire.shortAge
import com.yogesh.dray.wire.str
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

// Runs.swift's views: the runs sheet behind "N background tasks running", and a subagent's chat.

/**
 * Opens what a subagent row in the chat stands for, by its spawning call's id: its chat where it
 * has one, else the runs sheet on it. False where the chat holds no such run.
 */
val LocalOpenRun = staticCompositionLocalOf<((String) -> Boolean)?> { null }

/** One run `list_subagents` read off a log, which the loaded chat may not hold. */
@Serializable
data class SubagentSummary(
    val id: String,
    val sessionId: String,
    val taskId: String? = null,
    val label: String? = null,
    val description: String? = null,
    val startedAt: String = "",
    val endedAt: String? = null,
)

/** Finished runs per page, the desktop's. */
private const val RUNS_PAGE = 10

private fun Store.liveTasks(key: SessionKey): Set<String> = tasks[key].orEmpty().map { it.taskId }.toSet()

/** The session's runs as the store holds them now. */
fun Store.runsOf(key: SessionKey): List<AgentRun> =
    buildRuns(transcripts[key]?.events.orEmpty(), key, liveTasks(key), items[key]?.busy == true)

/** The runs on their own: a task's sheet, opened from its background line or a subagent row. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunsSheet(key: SessionKey, focus: String?, openChat: (String) -> Unit, dismiss: () -> Unit) {
    ModalBottomSheet(dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Dray.card) {
        Column(Modifier.fillMaxWidth().heightIn(min = 360.dp)) {
            Text("Subagents & tasks", Modifier.padding(horizontal = 20.dp).padding(bottom = 4.dp), style = Dray.Font.headline)
            Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 8.dp).padding(bottom = 24.dp)) {
                RunsSections(key, focus, openChat)
            }
        }
    }
}

/**
 * The subagents and background shells of a chat: the desktop's `BotRuns`. Running subagents always
 * show; finished ones fold under the heading and page in off the server's logs, since the chat
 * holds only its tail.
 */
@Composable
private fun RunsSections(key: SessionKey, focus: String?, openChat: (String) -> Unit) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    var older by remember { mutableStateOf(listOf<SubagentSummary>()) }
    var next by remember { mutableStateOf<JsonElement?>(null) }
    var loading by remember { mutableStateOf(false) }
    var showDone by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(focus) }

    val held = store.runsOf(key)
    val heldIds = held.map { it.id }.toSet()
    val live = store.liveTasks(key)
    val logged = older.filter { it.id !in heldIds }.map { s ->
        AgentRun(s.id, SessionKey(key.server, s.sessionId), taskId = s.taskId, label = s.label, description = s.description,
            done = s.endedAt != null || (s.taskId ?: s.id) !in live, lastAt = s.endedAt ?: s.startedAt, logOnly = true)
    }
    val known = (held + logged).flatMap { listOfNotNull(it.id, it.taskId) }.toSet()
    // Live tasks neither accounts for: a shell started before the loaded tail, or any task on a server without `list_subagents`.
    val orphans = store.tasks[key].orEmpty().filter { it.taskId !in known }.map {
        AgentRun(it.taskId, key, taskId = it.taskId, label = it.taskType, description = it.description, logOnly = true)
    }
    val all = held + logged + orphans
    val agents = all.filter { !it.shell }
    val running = agents.filter { !it.done }
    val completed = agents.filter { it.done }
    val shells = all.filter { it.shell && (!it.done || it.id == expanded) }

    /** Only a task the child holds can be stopped; `stop_task` answers success for any other. */
    fun stoppable(run: AgentRun) = !run.done && run.taskId != null && (run.taskId in live || store.items[run.session]?.busy == true)
    fun stop(run: AgentRun) {
        val task = run.taskId ?: return
        scope.launch {
            runCatching { store.call(run.session.server, "stop_task", jsonOf("sessionId" to run.session.id, "taskId" to task)) }
                .onFailure { store.lastError = it.message }
        }
    }

    /** A page of older runs. A server without `list_subagents` errors, leaving the loaded runs and live tasks as the whole list. */
    suspend fun load(cursor: JsonElement?) {
        if (loading) return
        loading = true
        val seen = held.flatMap { listOfNotNull(it.id, it.taskId) } + older.flatMap { listOfNotNull(it.id, it.taskId) }
        val unseen = live.filter { it !in seen }
        runCatching {
            store.call(key.server, "list_subagents", jsonOf(
                "sessionId" to key.id, "also" to emptyList<String>(), "cursor" to (cursor ?: JsonNull),
                "limit" to RUNS_PAGE, "live" to unseen,
            ))
        }.getOrNull()?.let { reply ->
            val had = older.map { it.id }.toSet()
            older = older + decodeList<SubagentSummary>(reply["runs"]).filter { it.id !in had }
            next = reply["next"]
        }
        loading = false
    }

    LaunchedEffect(key) {
        if (focus != null && held.any { it.id == focus && it.done && !it.shell }) showDone = true
        load(null)
    }

    @Composable
    fun row(run: AgentRun, at: String? = null) = RunRow(
        run, open = expanded == run.id, at = at, stoppable = stoppable(run),
        onToggle = { if (run.chat) openChat(run.id) else expanded = if (expanded == run.id) null else run.id },
        onStop = { stop(run) },
    )

    Column {
        if (running.isNotEmpty() || completed.isNotEmpty()) {
            RunsHeading("Subagents", running.filter(::stoppable), completed.size, more = next != null, open = showDone,
                toggle = { showDone = !showDone }, stopAll = { it.forEach(::stop) })
            running.forEach { row(it) }
            if (showDone) {
                completed.forEach { row(it, it.lastAt) }
                if (next != null) LoadMore(loading) { scope.launch { load(next) } }
            }
        }
        if (shells.isNotEmpty()) {
            RunsHeading("Background tasks", shells.filter(::stoppable), 0, more = false, open = false, toggle = {}, stopAll = { it.forEach(::stop) })
            shells.forEach { row(it) }
        }
        if (all.isEmpty()) {
            Text("No subagents or background tasks.", Modifier.fillMaxWidth().padding(top = 120.dp, bottom = 120.dp),
                style = Dray.Font.subhead.copy(color = Dray.secondary), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
    }
}

/** Stop all sits before the count, and only above two: with one, the row's own button is the job. */
@Composable
private fun RunsHeading(title: String, stoppable: List<AgentRun>, count: Int, more: Boolean, open: Boolean, toggle: () -> Unit, stopAll: (List<AgentRun>) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 16.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, Modifier.weight(1f).clickable(enabled = count > 0, onClick = toggle), style = Dray.Font.footnote.copy(color = Dray.secondary))
        if (stoppable.size > 1) Text("Stop all", Modifier.clickable { stopAll(stoppable) }, style = Dray.Font.footnoteStrong)
        if (count > 0) {
            Row(Modifier.clickable(onClick = toggle), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(if (more) "$count+" else "$count", style = Dray.Font.footnote.copy(color = Dray.secondary))
                Chevron(open)
            }
        }
    }
}

/** A finished row's frame, so the plus sits in the marks' column. */
@Composable
private fun LoadMore(loading: Boolean, load: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(44.dp).clickable(enabled = !loading, onClick = load).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) {
            if (loading) CircularProgressIndicator(Modifier.size(14.dp), color = Dray.secondary, strokeWidth = 2.dp)
            else Icon(Icons.Filled.Add, null, Modifier.size(16.dp), tint = Dray.secondary)
        }
        Text(if (loading) "Loading…" else "Load more", style = Dray.Font.subhead.copy(color = Dray.secondary))
    }
}

/** One run: its mark, title and live step, its time once done, and Stop while the child holds it. A tap opens what it is doing. */
@Composable
private fun RunRow(run: AgentRun, open: Boolean, at: String?, stoppable: Boolean, onToggle: () -> Unit, onStop: () -> Unit) {
    Column {
        Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                Modifier.weight(1f).heightIn(min = 44.dp).clickable(enabled = run.opens, onClick = onToggle),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) {
                    when {
                        run.shell -> Icon(Icons.Outlined.Terminal, null, Modifier.size(17.dp), tint = Dray.secondary)
                        run.done -> Icon(Icons.Filled.Check, null, Modifier.size(16.dp), tint = Dray.tertiary)
                        else -> Orb(OrbKind.Delegating)
                    }
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(run.title, if (!run.done && run.shell) Modifier.shimmer() else Modifier,
                        style = Dray.Font.body.copy(color = if (run.done) Dray.secondary else Dray.text), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (!run.shell && !run.done) run.status?.let {
                        Text(it, Modifier.shimmer(), style = Dray.Font.footnote.copy(color = Dray.tertiary), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                parseDate(at)?.let { Text(shortAge(it), style = Dray.Font.footnote.copy(color = Dray.tertiary)) }
            }
            if (stoppable) {
                Box(Modifier.size(32.dp).clip(RoundedCornerShape(8.dp)).clickable(onClick = onStop), contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Stop, if (run.shell) "Stop this task" else "Stop this subagent", Modifier.size(16.dp), tint = Dray.secondary)
                }
            }
        }
        AnimatedVisibility(open && run.opens && !run.chat, enter = fadeIn(), exit = fadeOut()) {
            Box(Modifier.padding(start = 44.dp, end = 12.dp, bottom = 12.dp)) { RunDetail(run) }
        }
    }
}

/**
 * What a run is doing: a shell's command over the tail of its output, read off the server while
 * it runs; a subagent's brief over its own calls and messages, live as they land.
 */
@Composable
private fun RunDetail(run: AgentRun) {
    val store = LocalStore.current
    var output by remember(run.id) { mutableStateOf<String?>(null) }
    var outputError by remember(run.id) { mutableStateOf<String?>(null) }
    // The answer lands after the task starts and carries the path; a cut one may hold half a path, so the call is read whole first.
    LaunchedEffect(run.done, run.answer, run.cutCalls) {
        for (id in run.cutCalls) store.completeCall(run.session, id)
        if (run.cut || run.command == null) return@LaunchedEffect
        val path = outputPath(run.answer)
        if (path == null) {
            if (run.answer != null || run.done) outputError = "This agent doesn't say where the output goes."
            return@LaunchedEffect
        }
        while (true) {
            try {
                val text = store.call(run.session.server, "read_file", jsonOf("path" to path))["text"].str.orEmpty()
                // The tail: a dev server's log grows for hours, and what it says now is at the end.
                output = text.split("\n").takeLast(30).joinToString("\n").trim()
                outputError = null
            } catch (e: Exception) {
                outputError = sentence(e.message ?: "Couldn't read the output")
            }
            if (run.done) break
            delay(2000)
        }
    }
    CompositionLocalProviderCallSession(run.session) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            val command = run.command
            if (command != null) {
                SelectionContainer {
                    Text("$ $command", Modifier.fillMaxWidth().well().padding(8.dp), style = Dray.Font.code)
                }
                output?.let {
                    SelectionContainer {
                        Text(it.ifEmpty { "No output yet." }, Modifier.fillMaxWidth().well().horizontalScroll(rememberScrollState()).padding(8.dp),
                            style = Dray.Font.code.copy(color = Dray.secondary), softWrap = false)
                    }
                }
                // Under any text already read, so a read that stops working never passes for a live one.
                outputError?.let { Text(it, style = Dray.Font.footnote.copy(color = Dray.tertiary)) }
            } else {
                run.brief?.let { Text(it, style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = 6, overflow = TextOverflow.Ellipsis) }
                runItems(run.events, run.done).forEach { ItemRow(it) }
                if (run.events.isEmpty() && !run.done) Text("Nothing reported yet.", style = Dray.Font.footnote.copy(color = Dray.tertiary))
            }
            CutCallsFailed(run)
        }
    }
}

@Composable
private fun CompositionLocalProviderCallSession(key: SessionKey, content: @Composable () -> Unit) =
    androidx.compose.runtime.CompositionLocalProvider(LocalCallSession provides key, LocalImageServer provides key.server, content = content)

/** A cut brief or handback whose whole read failed, with its retry. */
@Composable
private fun CutCallsFailed(run: AgentRun) {
    val store = LocalStore.current
    val failed = run.cutCalls.filter { store.callFailed(run.session, it) }
    if (failed.isEmpty()) return
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Couldn't load this.", style = Dray.Font.footnote.copy(color = Dray.secondary))
        Text("Retry", Modifier.clickable { failed.forEach { store.completeCall(run.session, it) } }, style = Dray.Font.footnote)
    }
}

/**
 * A subagent's conversation as a chat of its own: the desktop's `SubagentView`. Claude Code streams
 * a child's work into the parent's log, so it is live here; fx streams none of it, so its run is
 * read back from fx's own store once its turn ends.
 */
@Composable
fun SubagentChat(key: SessionKey, id: String, back: () -> Unit) {
    val store = LocalStore.current
    val run = store.runsOf(key).firstOrNull { it.id == id }
    var fx by remember(id) { mutableStateOf<List<AgentEvent>?>(null) }
    var fxError by remember(id) { mutableStateOf<String?>(null) }
    val items = run?.let { runItems(if (it.fxAgent == null) it.events else fx.orEmpty(), it.done) }.orEmpty()
    BackHandler(onBack = back)
    LaunchedEffect(run?.cutCalls) { run?.cutCalls?.forEach { store.completeCall(key, it) } }
    // fx's report landing is when the child's turn is saved and worth reading again.
    LaunchedEffect(run?.answer) {
        val agent = run?.fxAgent ?: return@LaunchedEffect
        try {
            fx = AgentEvent.list(store.call(key.server, "fx_subagent_events", jsonOf("sessionId" to key.id, "agent" to agent)))
            fxError = null
        } catch (e: Exception) {
            fxError = e.message
        }
    }
    val list = rememberLazyListState()
    LaunchedEffect(items.size, run?.done) { if (items.isNotEmpty()) list.scrollToItem(0) }
    CompositionLocalProviderCallSession(key) {
        Column(Modifier.fillMaxSize().background(Dray.page).statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().height(56.dp).padding(end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Dray.text) }
                Text(run?.title ?: "Subagent", style = Dray.Font.headline, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            SelectionContainer {
                LazyColumn(
                    Modifier.fillMaxSize(), state = list, reverseLayout = true,
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp, Alignment.Bottom),
                ) {
                    if (run == null) return@LazyColumn
                    item("foot") {
                        MaxWidth {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                when {
                                    !run.done -> OrbLine(OrbKind.Delegating, run.status ?: "Working")
                                    fxError != null -> Text(sentence(fxError!!), style = Dray.Font.footnote.copy(color = Dray.secondary))
                                }
                                CutCallsFailed(run)
                            }
                        }
                    }
                    items.reversed().forEach { item -> item(item.id) { MaxWidth { ItemRow(item) } } }
                    val brief = run.brief
                    if (brief != null && items.none { it is Item.Prompt }) item("brief") { MaxWidth { UserBubble(TurnPrompt(brief, null, emptyList())) } }
                }
            }
        }
    }
}
