package com.yogesh.dray.ui

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.BranchList
import com.yogesh.dray.model.Model
import com.yogesh.dray.model.Picks
import com.yogesh.dray.store.NewTask
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.wireJson
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer

private enum class RunWithPage { Main, Attach, Models }

/**
 * Everything a new task starts on, opened from any pick under the new task field: where it
 * runs, the agent, the model, and effort, fast mode and stance. iOS's RunWith.swift.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunWithSheet(task: NewTask, dismiss: () -> Unit) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    var page by remember { mutableStateOf(RunWithPage.Main) }
    var branches by remember { mutableStateOf<BranchList?>(null) }
    // Read off the save that failed, never `task.failure` on open: that may be an older start's.
    var saveError by remember { mutableStateOf<String?>(null) }
    val server = task.server
    val cwd = task.cwd

    LaunchedEffect(server, cwd) {
        branches = null
        if (server != null && cwd != null && task.bot == null) {
            branches = runCatching { decodeOrNull<BranchList>(store.call(server, "list_branches", jsonOf("cwd" to cwd))) }.getOrNull()
        }
    }
    LaunchedEffect(server, task.harness) { task.load() }

    ModalBottomSheet(
        dismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Dray.card,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        // A page inside the sheet takes Back for itself, to step out to the picks.
        properties = ModalBottomSheetProperties(shouldDismissOnBackPress = page == RunWithPage.Main),
    ) {
        BackHandler(page != RunWithPage.Main) { page = RunWithPage.Main }
        when (page) {
            RunWithPage.Main -> PickSheet("Run with", done = dismiss) {
                PickSection("Where") { WhereCard(task, branches) { page = RunWithPage.Attach } }
                val agents = task.available.filter { it.available }
                if (agents.isNotEmpty()) {
                    PickSection("Agent") {
                        ChipRow(focus = agents.indexOfFirst { it.harness == task.harness }) {
                            items(agents, key = { it.harness }) { a ->
                                PickChip(a.label, a.harness == task.harness, harness = a.harness) { task.pickHarness(a.harness) }
                            }
                        }
                    }
                }
                PickSection("Model") {
                    ModelChips(task.list, task.harness, task.modelId, task::pickModel) { page = RunWithPage.Models }
                }
                SettingsCard(task)
                if (task.hasText) {
                    PickCard {
                        Row(
                            Modifier.clickable(enabled = !task.sending) {
                                scope.launch { if (task.saveDraft()) dismiss() else saveError = task.failure }
                            }.rowFrame(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Dray.Space.s),
                        ) {
                            Icon(Icons.Outlined.Archive, null, Modifier.size(18.dp), tint = Dray.text)
                            Text("Save draft", Modifier.weight(1f), style = Dray.Font.body)
                            if (task.sending) CircularProgressIndicator(Modifier.size(18.dp), color = Dray.secondary, strokeWidth = 2.dp)
                        }
                    }
                    saveError?.let { PickNote(sentence(it), Dray.destructive) }
                }
            }
            RunWithPage.Attach -> server?.let { s ->
                AttachProject(s, store.projects[s].orEmpty(), back = { page = RunWithPage.Main }) { list ->
                    store.attached(s, list)
                    task.pickProject(list.maxByOrNull { it.lastSelected }?.name)
                    page = RunWithPage.Main
                }
            }
            RunWithPage.Models -> ModelLibrary(task.list, task.harness) { page = RunWithPage.Main }
        }
    }
}

/** Server first: the project menu lists what the picked server holds. */
@Composable
private fun WhereCard(task: NewTask, branches: BranchList?, attach: () -> Unit) {
    val store = LocalStore.current
    PickCard {
        val connected = task.connected
        if (connected.isNotEmpty()) {
            PickMenu("Server", task.server?.let { store.name(it) }.orEmpty(), connected.map { it.id to it.name }, task.server, task::pickServer)
            PickDivider()
        }
        val bot = task.bot
        val choices = task.projectChoices
        when {
            // Its folder is not a repo: no worktree to pick. A project picked here leaves the bot.
            bot != null -> PickMenu("Project", bot.second.name, choices.map { it to it.label }, null, pick = { task.pick(it) })
            choices.isEmpty() -> Row(
                Modifier.alpha(if (task.server == null) 0.35f else 1f).clickable(enabled = task.server != null, onClick = attach).rowFrame(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Dray.Space.s),
            ) {
                Icon(Icons.Filled.Add, null, Modifier.size(18.dp), tint = Dray.text)
                Text("Attach project", Modifier.weight(1f), style = Dray.Font.body)
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(20.dp), tint = Dray.tertiary)
            }
            else -> {
                PickMenu("Project", task.projectChoice?.label.orEmpty(), choices.map { it to it.label }, task.projectChoice, { task.pick(it) }) {
                    HorizontalDivider(color = Dray.hairline)
                    MenuItem("Attach project…", false, leading = { Icon(Icons.Filled.Add, null, Modifier.size(18.dp), tint = Dray.text) }) { it(); attach() }
                }
                PickDivider()
                PickRow("Worktree", detail = if (task.worktree) branches?.defaultBase?.let { "from $it" } else null) {
                    PickSwitch(task.worktree, set = task::pickWorktree)
                }
            }
        }
    }
}

@Composable
private fun SettingsCard(task: NewTask) {
    val model = task.model
    val effort = model != null && model.efforts.isNotEmpty()
    val fast = Picks.offersFast(task.harness, model)
    val stance = Picks.offersStances(task.harness)
    if (!effort && !fast && !stance) return
    PickCard {
        if (effort && model != null) {
            PickMenu("Effort", task.effort?.let { Picks.effortLabels[it] ?: it }.orEmpty(),
                model.efforts.map { it to (Picks.effortLabels[it] ?: it) }, task.effort, task::pickEffort)
        }
        if (fast) {
            if (effort) PickDivider()
            PickRow("Fast mode") { PickSwitch(task.fast, set = task::pickFast) }
        }
        if (stance) {
            if (effort || fast) PickDivider()
            PickMenu("Permissions", task.stanceLabel, Picks.stances.filter { Picks.honours(task.harness, it.first) },
                Picks.stanceFor(task.harness, task.stance), task::pickStance)
        }
    }
}

/** The shortlist lives on this phone, per agent; null until edited, which draws every model the server doesn't mark secondary. */
private fun shortlist(context: Context, harness: String): List<String>? =
    context.getSharedPreferences("new", Context.MODE_PRIVATE).getString("shortlist.$harness", null)
        ?.let { runCatching { wireJson.decodeFromString(ListSerializer(String.serializer()), it) }.getOrNull() }

private fun saveShortlist(context: Context, harness: String, ids: List<String>) =
    context.getSharedPreferences("new", Context.MODE_PRIVATE).edit()
        .putString("shortlist.$harness", wireJson.encodeToString(ListSerializer(String.serializer()), ids)).apply()

private fun listed(m: Model, list: List<String>?) = list?.contains(m.id) ?: (m.secondary != true)

/** An agent's shortlisted models as chips, and More models to edit the list. */
@Composable
fun ModelChips(models: List<Model>, harness: String, selected: String, pick: (String) -> Unit, more: () -> Unit) {
    val context = LocalContext.current
    val list = remember(harness, models) { shortlist(context, harness) }
    // pi and fx run their own default where nothing is picked, so that is a choice too.
    val choices = (if (Picks.defaultModel[harness] == "") listOf("" to "Default") else emptyList()) +
        models.filter { listed(it, list) || it.id == selected }.map { it.id to it.label }
    ChipRow(focus = choices.indexOfFirst { it.first == selected }) {
        items(choices, key = { it.first }) { (id, label) -> PickChip(label, id == selected) { pick(id) } }
        if (models.isNotEmpty()) item("more") { PickChip("More models", false, onClick = more) }
    }
}

/** Every model the agent has, each switched on or off the shortlist. */
@Composable
private fun ModelLibrary(models: List<Model>, harness: String, back: () -> Unit) {
    val context = LocalContext.current
    var list by remember(harness) { mutableStateOf(shortlist(context, harness)) }
    PickSheet("Models", back = back) {
        PickSection(null, footer = "Models switched on show in the picker.") {
            PickCard {
                models.forEachIndexed { i, m ->
                    if (i > 0) PickDivider()
                    PickRow(m.label) {
                        PickSwitch(listed(m, list)) { on ->
                            val ids = (list ?: models.filter { it.secondary != true }.map { it.id }).filter { it != m.id } + listOfNotNull(m.id.takeIf { on })
                            list = ids
                            saveShortlist(context, harness, ids)
                        }
                    }
                }
            }
        }
    }
}

// Pieces

/** A picks sheet's frame: the title over Done on the right (or Back on the left), then sections 24dp apart. */
@Composable
fun PickSheet(title: String, done: (() -> Unit)? = null, back: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.padding(horizontal = Dray.Space.l)) {
        Box(Modifier.fillMaxWidth().height(44.dp), contentAlignment = Alignment.Center) {
            Text(title, style = Dray.Font.headline)
            back?.let {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", Modifier.align(Alignment.CenterStart).clip(CircleShape).clickable(onClick = it).padding(6.dp), tint = Dray.text)
            }
            done?.let {
                Text("Done", Modifier.align(Alignment.CenterEnd).clip(RoundedCornerShape(Dray.Radius.sm)).clickable(onClick = it).padding(horizontal = 6.dp, vertical = 4.dp), style = Dray.Font.headline)
            }
        }
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(top = Dray.Space.m, bottom = Dray.Space.xxl),
            verticalArrangement = Arrangement.spacedBy(Dray.Space.xl),
            content = content,
        )
    }
}

/** A grey label over its content, with an optional note under it. */
@Composable
fun PickSection(label: String?, footer: String? = null, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Dray.Space.s)) {
        label?.let { PickNote(it) }
        content()
        footer?.let { PickNote(it) }
    }
}

@Composable
fun PickNote(line: String, color: androidx.compose.ui.graphics.Color = Dray.tertiary) {
    Text(line, Modifier.padding(horizontal = Dray.Space.l), style = Dray.Font.footnote.copy(color = color))
}

@Composable
fun PickCard(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.raised), content = content)
}

@Composable
fun PickDivider() {
    Box(Modifier.padding(start = Dray.Space.l).fillMaxWidth().height(1.dp).background(Dray.hairline))
}

/** A card row's 52dp height and its 16/14 insets. */
fun Modifier.rowFrame(): Modifier = fillMaxWidth().heightIn(min = 52.dp).padding(start = 16.dp, end = 14.dp)

/** A 52dp card row: the label, a grey note beside it where there is one, and what it holds. */
@Composable
fun PickRow(label: String, modifier: Modifier = Modifier, detail: String? = null, trailing: @Composable RowScope.() -> Unit) {
    Row(modifier.rowFrame(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(if (detail == null) Dray.Space.s else 6.dp)) {
        Text(label, if (detail == null) Modifier.weight(1f) else Modifier, style = Dray.Font.body, maxLines = 1)
        detail?.let { Text(it, Modifier.weight(1f), style = Dray.Font.body.copy(color = Dray.tertiary), maxLines = 1, overflow = TextOverflow.Ellipsis) }
        trailing()
    }
}

/**
 * A card row whose value is picked from a menu, a check by the current one. [extra] adds rows
 * under the choices, handed the menu's close.
 */
@Composable
fun <T> PickMenu(
    label: String, value: String, choices: List<Pair<T, String>>, selected: T?, pick: (T) -> Unit,
    extra: (@Composable (close: () -> Unit) -> Unit)? = null,
) {
    var open by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    Box {
        PickRow(label, Modifier.clickable { open = true }) {
            Text(value, Modifier.widthIn(max = 200.dp), style = Dray.Font.body.copy(color = Dray.secondary, textAlign = TextAlign.End),
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(Icons.Filled.UnfoldMore, null, Modifier.size(16.dp), tint = Dray.tertiary)
        }
        Box(Modifier.align(Alignment.BottomEnd).padding(end = 14.dp)) {
            DropdownMenu(open, { open = false }, containerColor = Dray.tile, shape = RoundedCornerShape(Dray.Radius.lg)) {
                for ((v, text) in choices) MenuItem(text, v == selected) {
                    open = false
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    pick(v)
                }
                extra?.invoke { open = false }
            }
        }
    }
}

@Composable
private fun MenuItem(text: String, checked: Boolean, leading: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    DropdownMenuItem(
        { Text(text, style = Dray.Font.body, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        onClick,
        leadingIcon = leading ?: { Box(Modifier.width(18.dp)) { if (checked) Icon(Icons.Filled.Check, null, Modifier.size(18.dp), tint = Dray.text) } },
        contentPadding = PaddingValues(start = 12.dp, end = 20.dp),
    )
}

/** The picks' switch: light with a dark knob when on, grey when off, as the iOS frames draw it. */
@Composable
fun PickSwitch(on: Boolean, enabled: Boolean = true, set: (Boolean) -> Unit) {
    val haptics = LocalHapticFeedback.current
    Switch(on, { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); set(it) }, enabled = enabled, colors = SwitchDefaults.colors(
        checkedTrackColor = Dray.primary, checkedThumbColor = Dray.onPrimary, uncheckedTrackColor = Dray.off,
        uncheckedThumbColor = Dray.secondary, uncheckedBorderColor = Dray.off))
}

/** Chips in one sideways line running to the sheet's edges, scrolled to the chip at [focus] when it moves off screen. */
@Composable
fun ChipRow(focus: Int? = null, content: LazyListScope.() -> Unit) {
    val state = rememberLazyListState()
    LaunchedEffect(focus) {
        if (focus == null || focus < 0) return@LaunchedEffect
        val info = state.layoutInfo
        val shown = info.visibleItemsInfo.firstOrNull { it.index == focus }
        if (shown == null || shown.offset < info.viewportStartOffset || shown.offset + shown.size > info.viewportEndOffset) {
            state.animateScrollToItem(maxOf(0, focus - 1))
        }
    }
    LazyRow(
        Modifier.layout { measurable, constraints ->
            // Wider than the sheet's padding by its inset each side, so chips scroll out to the edge.
            val bleed = Dray.Space.l.roundToPx()
            val placeable = measurable.measure(constraints.copy(minWidth = constraints.maxWidth + 2 * bleed, maxWidth = constraints.maxWidth + 2 * bleed))
            layout(constraints.maxWidth, placeable.height) { placeable.place(-bleed, 0) }
        },
        state = state,
        contentPadding = PaddingValues(horizontal = Dray.Space.l),
        horizontalArrangement = Arrangement.spacedBy(Dray.Space.s),
        content = content,
    )
}

/** One choice in a chip row: light when picked. An agent carries its mark. */
@Composable
fun PickChip(label: String, selected: Boolean, harness: String? = null, onClick: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    Row(
        Modifier.height(36.dp).clip(CircleShape).background(if (selected) Dray.text else Dray.tile)
            .clickable { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        harness?.let {
            AgentMark(it, 13.dp, if (selected) Dray.page else Dray.text)
            Spacer(Modifier.width(6.dp))
        }
        Text(label, style = (if (selected) Dray.Font.pill else Dray.Font.subhead).copy(color = if (selected) Dray.page else Dray.text), maxLines = 1)
    }
}
