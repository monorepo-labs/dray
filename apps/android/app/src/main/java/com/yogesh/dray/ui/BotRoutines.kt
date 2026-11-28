package com.yogesh.dray.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.nextRunLabel
import com.yogesh.dray.model.scheduleLabel
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.store.Store
import com.yogesh.dray.store.deleteRoutine
import com.yogesh.dray.store.routines
import com.yogesh.dray.store.setRoutinePaused
import com.yogesh.dray.store.updateRoutine
import com.yogesh.dray.wire.Routine
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// A bot's routines, under its tasks: iOS's `BotRoutines` and the desktop's RoutinesSection.tsx.

/**
 * One bot's routines as its Tasks sheet holds them, read on open, on every `routines_changed`, on a
 * reconnect, which may have missed one, and once a minute as the desktop does. Pause, delete and
 * save each answer whether they went through; one that fails leaves its reason in [error] until
 * the next succeeds.
 */
@Stable
class BotRoutinesModel(private val store: Store, val server: String, val botId: String) {
    var list by mutableStateOf<List<Routine>>(emptyList())
        private set
    var error by mutableStateOf<String?>(null)
        private set
    /** The clock "Next in" is read against, ticking once a minute. */
    var now by mutableLongStateOf(System.currentTimeMillis())
        internal set

    suspend fun read() {
        store.routines(server, botId)?.let { list = it }
    }

    /** The switch moves at once and goes back where the server refused, or never answered. */
    suspend fun setPaused(r: Routine, paused: Boolean): Boolean {
        fun set(to: Boolean) { list = list.map { if (it.id == r.id) it.copy(paused = to) else it } }
        set(paused)
        val ok = act(if (paused) "Couldn't pause it" else "Couldn't resume it") { store.setRoutinePaused(server, r.id, paused) }
        if (!ok) set(r.paused)
        return ok
    }

    suspend fun delete(r: Routine) = act("Couldn't delete it") { store.deleteRoutine(server, r.id) }

    suspend fun save(r: Routine, name: String, prompt: String) = act("Couldn't save it") {
        store.updateRoutine(server, r.id, name, prompt)?.let { saved -> list = list.map { if (it.id == saved.id) saved else it } }
    }

    private suspend fun act(failed: String, block: suspend () -> Unit): Boolean {
        val ok = try {
            block()
            error = null
            true
        } catch (e: Exception) {
            error = "$failed: ${sentence(e.message ?: "the server didn't answer.")}"
            false
        }
        read()
        return ok
    }
}

/** The routines of `botId` on `server`, kept fresh while the sheet is up. */
@Composable
fun rememberBotRoutines(server: String, botId: String): BotRoutinesModel {
    val store = LocalStore.current
    val model = remember(server, botId) { BotRoutinesModel(store, server, botId) }
    val revision = store.botState.routinesRevision[server] ?: 0
    val up = store.serverState[server] == ConnState.Connected
    LaunchedEffect(model, revision, up) {
        while (true) {
            model.read()
            delay(60_000)
        }
    }
    LaunchedEffect(model) {
        while (true) {
            model.now = System.currentTimeMillis()
            delay(60_000 - model.now % 60_000)
        }
    }
    return model
}

/**
 * The Routines section: a row per routine with its schedule and next run. The switch turns one off
 * and on, a long press offers Delete, and a tap opens it in [RoutineDetails]. Drawn only with one in it.
 */
@Composable
fun BotRoutines(model: BotRoutinesModel, open: (Routine) -> Unit) {
    if (model.list.isEmpty()) return
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    Column {
        // The runs list's section heading, so it reads as one more of the sheet's sections.
        Text("Routines", Modifier.padding(start = 12.dp, top = 20.dp, bottom = 4.dp), style = Dray.Font.footnote.copy(color = Dray.secondary))
        model.error?.let {
            Text(it, Modifier.padding(start = 12.dp, end = 12.dp, bottom = 4.dp), style = Dray.Font.footnote.copy(color = Dray.destructive))
        }
        for (r in model.list) RoutineRow(
            r, model.now,
            onOpen = { open(r) },
            onPause = { paused ->
                scope.launch {
                    if (!model.setPaused(r, paused)) haptics.performHapticFeedback(HapticFeedbackType.Reject)
                }
            },
            onDelete = {
                scope.launch {
                    haptics.performHapticFeedback(if (model.delete(r)) HapticFeedbackType.Confirm else HapticFeedbackType.Reject)
                }
            },
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RoutineRow(r: Routine, now: Long, onOpen: () -> Unit, onPause: (Boolean) -> Unit, onDelete: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(Dray.Radius.md))
                .combinedClickable(onClickLabel = "Open ${r.name}", onClick = onOpen, onLongClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    menu = true
                })
                .padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(Icons.Outlined.Schedule, null, Modifier.size(20.dp).alpha(if (r.paused) 0.5f else 1f), tint = Dray.secondary)
            Column(Modifier.weight(1f)) {
                Text(
                    r.name, style = Dray.Font.body.copy(color = if (r.paused) Dray.secondary else Dray.text),
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${scheduleLabel(r)} · ${nextRunLabel(r, now)}", style = Dray.Font.footnote.copy(color = Dray.secondary),
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            // The row opens on a tap, so the switch keeps its own.
            Box(Modifier.semantics { contentDescription = if (r.paused) "Turn on ${r.name}" else "Turn off ${r.name}" }) {
                PickSwitch(!r.paused) { on -> onPause(!on) }
            }
        }
        DropdownMenu(menu, { menu = false }, Modifier.widthIn(min = 200.dp), containerColor = Dray.raised) {
            DropdownMenuItem(
                text = { Text("Delete routine", style = Dray.Font.body.copy(color = Dray.destructive)) },
                onClick = { menu = false; onDelete() },
            )
        }
    }
}

/**
 * One routine, drawn over the whole Tasks sheet in place of its list: name and instructions to edit,
 * the schedule to read. Edits are kept here until Save, so a bot changing the routine meanwhile shows
 * through only on fields the reader has not touched.
 */
@Composable
fun RoutineDetails(model: BotRoutinesModel, routine: Routine, back: () -> Unit) {
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    // Null is untouched: the routine's own value shows, and moves with it.
    var name by rememberSaveable(routine.id) { mutableStateOf<String?>(null) }
    var prompt by rememberSaveable(routine.id) { mutableStateOf<String?>(null) }
    var saving by remember(routine.id) { mutableStateOf(false) }
    val shownName = name ?: routine.name
    val shownPrompt = prompt ?: routine.prompt
    val changed = shownName.trim() != routine.name || shownPrompt.trim() != routine.prompt
    val valid = shownName.isNotBlank() && shownPrompt.isNotBlank()
    val ready = changed && valid && !saving

    fun save() {
        if (!ready) return
        saving = true
        scope.launch {
            val ok = model.save(routine, shownName, shownPrompt)
            saving = false
            haptics.performHapticFeedback(if (ok) HapticFeedbackType.Confirm else HapticFeedbackType.Reject)
            if (ok) { name = null; prompt = null }
        }
    }

    Column {
        Row(Modifier.padding(start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Dray.text) }
            Text("Routines", style = Dray.Font.subhead.copy(color = Dray.secondary))
        }
        Column(Modifier.padding(horizontal = 12.dp).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Field("Name") {
                BasicTextField(
                    shownName, { name = it }, Modifier.fillMaxWidth().semantics { contentDescription = "Name" },
                    textStyle = Dray.Font.body, singleLine = true, cursorBrush = SolidColor(Dray.text),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                )
            }
            // A routine's prompt is usually a paragraph or a checklist, so the box starts tall and grows with it.
            Field("Instructions") {
                BasicTextField(
                    shownPrompt, { prompt = it }, Modifier.fillMaxWidth().heightIn(min = 112.dp).semantics { contentDescription = "Instructions" },
                    textStyle = Dray.Font.body, cursorBrush = SolidColor(Dray.text),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Schedule", style = Dray.Font.footnote.copy(color = Dray.secondary))
                Text("${scheduleLabel(routine)} · ${nextRunLabel(routine, model.now)}", style = Dray.Font.body)
            }
            model.error?.let { Text(it, style = Dray.Font.footnote.copy(color = Dray.destructive)) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                val fill = if (ready || saving) Dray.primary else Dray.primary.copy(alpha = 0.45f)
                Box(
                    Modifier.height(40.dp).clip(CircleShape).background(fill)
                        .clickable(enabled = ready, onClick = ::save).padding(horizontal = 16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    if (saving) CircularProgressIndicator(Modifier.size(18.dp), color = Dray.onPrimary, strokeWidth = 2.dp)
                    else Text("Save changes", style = Dray.Font.pill.copy(color = Dray.onPrimary))
                }
                if (changed) Box(
                    Modifier.height(40.dp).clip(CircleShape).clickable(enabled = !saving) { name = null; prompt = null }.padding(horizontal = 16.dp),
                    contentAlignment = Alignment.Center,
                ) { Text("Discard", style = Dray.Font.pill.copy(color = Dray.secondary)) }
            }
        }
    }
}

/** A labelled box for one of the details' fields. */
@Composable
private fun Field(label: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = Dray.Font.footnote.copy(color = Dray.secondary))
        Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.md)).background(Dray.raised).padding(horizontal = 12.dp, vertical = 10.dp)) {
            content()
        }
    }
}
