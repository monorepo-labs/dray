package com.yogesh.dray.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.yogesh.dray.model.Model
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.voice.Dictation
import com.yogesh.dray.voice.Dictations
import com.yogesh.dray.voice.dictationEngine
import com.yogesh.dray.voice.typesOnly
import com.yogesh.dray.wire.jsonOf
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

/** Where the dock is: resting under the list, or open over it. */
private enum class DockPhase { Rest, Recording, Transcribing, Ready }

/** The new task's words, kept in `store.drafts` like any reply's. */
val NewTaskDraft = SessionKey("", "new-task")

/**
 * The bottom of the list: the voice orb, tapped to talk, and the picks a new task starts on. A tap
 * opens the dock over the list — recording until tapped again or Done, then transcribing, then the
 * words ready to start or to add to with another tap. The keyboard edits the same text in a sheet,
 * and a swipe up opens it too. VoiceDock.swift. Everything about the task itself — its picks,
 * starting it, saving it as a draft — comes from the caller.
 */
@Composable
fun VoiceDock(
    sending: Boolean,
    /** The task can start: words, a machine and a project. */
    ready: Boolean,
    /** Why the last start failed, said where dictation's notes are. */
    failure: String?,
    clearFailure: () -> Unit,
    start: () -> Unit,
    picks: @Composable (edit: (() -> Unit)?) -> Unit,
    modifier: Modifier = Modifier,
    saveDraft: (() -> Unit)? = null,
) {
    val store = LocalStore.current
    val draft = NewTaskDraft
    val haptics = LocalHapticFeedback.current
    val dictation = Dictations.state(draft)
    val text = store.drafts[draft].orEmpty()
    val hasText = text.isNotBlank()
    // Never mid-recording, or losing the one server that could would take Done away with the mic still on.
    val typing = store.typesOnly && dictation == Dictation.Idle
    val phase = when {
        typing -> DockPhase.Rest
        dictation == Dictation.Starting || dictation == Dictation.Recording -> DockPhase.Recording
        dictation == Dictation.Transcribing -> DockPhase.Transcribing
        hasText -> DockPhase.Ready
        else -> DockPhase.Rest
    }
    val open = phase != DockPhase.Rest
    val busy = phase == DockPhase.Recording || phase == DockPhase.Transcribing
    var hint by remember { mutableStateOf<String?>(null) }
    var confirming by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var sheetTitle by remember { mutableStateOf("New task") }
    val withMic = rememberWithMic(draft)
    val note = Dictations.notes[draft] ?: failure
    LaunchedEffect(phase) { confirming = false }
    LaunchedEffect(hint) { if (hint != null) { delay(2000); hint = null } }

    fun edit() {
        sheetTitle = if (hasText) "Edit task" else "New task"
        if (Dictations.kept[draft] == null) Dictations.notes.remove(draft)
        clearFailure()
        editing = true
    }

    // Tap to talk, tap again to stop: the orb is never held.
    fun tapped() {
        if (dictation == Dictation.Recording) return Dictations.stop(store, draft)
        if (busy) return
        val engine = store.dictationEngine() ?: run { hint = "Nothing can transcribe right now. Type instead."; return }
        // A kept recording is the only copy of what was said; it goes by Retry or Discard, never by a new tap.
        if (Dictations.kept[draft] != null) return
        Dictations.dismiss(draft)
        clearFailure()
        withMic {
            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            Dictations.start(store, engine, draft)
        }
    }

    // The page showing through at rest, and nearly closed over the list once open.
    val backdrop = when (phase) {
        DockPhase.Rest -> Brush.verticalGradient(0f to Dray.page.copy(alpha = 0f), 0.26f to Dray.page)
        DockPhase.Ready -> Brush.verticalGradient(listOf(Dray.page.copy(alpha = 0.97f), Dray.page))
        else -> Brush.verticalGradient(0f to Dray.page.copy(alpha = 0.6f), 0.45f to Dray.page.copy(alpha = 0.88f), 0.7f to Dray.page)
    }

    Column(
        modifier
            .fillMaxWidth()
            .then(if (open) Modifier.fillMaxSize() else Modifier)
            .background(backdrop)
            // Open, the dock is the screen: a touch on it never reaches the list behind.
            .then(if (open) Modifier.clickable(remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, null) {} else Modifier)
            .navigationBarsPadding()
            .padding(horizontal = 20.dp)
            .padding(top = if (open) 0.dp else 44.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Bottom,
    ) {
        if (phase == DockPhase.Ready) {
            SpokenText(text, Modifier.weight(1f)) { edit() }
        } else if (open) {
            Spacer(Modifier.weight(1f))
        }
        if (!open) {
            val line = hint ?: note
            if (line != null) KeptNote(line, draft, Modifier.padding(bottom = 14.dp))
            else if (!typing) Text("Swipe up to type", Modifier.padding(bottom = 14.dp), style = Dray.Font.footnote.copy(color = Dray.tertiary))
        }
        Column(
            Modifier.fillMaxWidth().padding(bottom = 24.dp).pointerSwipeUp(phase == DockPhase.Rest && !typing) { edit() },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (typing) {
                ChatField("New task", text, { store.drafts[draft] = it }, sending, sendable = ready && !sending, send = start)
            } else {
                DockOrb(draft, if (open) 120.dp else 76.dp, ::tapped, Modifier.animateContentSize())
            }
            AnimatedVisibility(open, enter = fadeIn(), exit = fadeOut()) {
                DockActions(
                    draft, phase, confirming, note, sending, ready,
                    onConfirm = { confirming = it },
                    onStart = start,
                    onDiscard = {
                        if (phase == DockPhase.Ready) { store.drafts.remove(draft); clearFailure() } else Dictations.cancel(draft)
                        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    },
                    saveDraft = saveDraft,
                    discardAsks = phase != DockPhase.Ready || hasText,
                    modifier = Modifier.padding(top = 24.dp),
                )
            }
            Box(Modifier.padding(top = if (open) 18.dp else 14.dp)) { picks(if (typing || busy) null else ::edit) }
        }
    }
    if (editing) TextSheet(sheetTitle, text, { store.drafts[draft] = it }) { editing = false }
}

/** What the open dock's buttons say: Cancel and Done while recording, Cancel and Start once words are in, and the discard question. */
@Composable
private fun DockActions(
    draft: SessionKey, phase: DockPhase, confirming: Boolean, note: String?, sending: Boolean, ready: Boolean,
    onConfirm: (Boolean) -> Unit, onStart: () -> Unit, onDiscard: () -> Unit, saveDraft: (() -> Unit)?,
    discardAsks: Boolean, modifier: Modifier = Modifier,
) {
    val store = LocalStore.current
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (confirming) {
            Text(if (phase == DockPhase.Ready) "Discard this task?" else "Discard this recording?", style = Dray.Font.subhead.copy(color = Dray.secondary))
        } else if (note != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(note, Modifier.weight(1f, fill = false), style = Dray.Font.subhead.copy(color = Dray.secondary), textAlign = TextAlign.Center)
                if (Dictations.kept[draft] != null) {
                    Text("Retry", Modifier.clickable { Dictations.retry(store, draft) }, style = Dray.Font.subhead)
                    Text("Discard", Modifier.clickable { Dictations.dismiss(draft) }, style = Dray.Font.subhead.copy(color = Dray.destructive))
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (confirming) {
                if (phase == DockPhase.Ready && saveDraft != null) DockButton("Save draft", enabled = !sending) { saveDraft() }
                DockButton(if (phase == DockPhase.Recording) "Keep recording" else "Keep") { onConfirm(false) }
                DockButton("Discard", DockKind.Destructive) { onDiscard(); onConfirm(false) }
            } else {
                // Nothing said and nothing written: there is nothing to lose, so nothing to ask.
                DockButton("Cancel") { if (discardAsks) onConfirm(true) else onDiscard() }
                if (phase == DockPhase.Recording) {
                    DockButton("Done", DockKind.Primary, enabled = Dictations.state(draft) == Dictation.Recording, leading = {
                        Box(Modifier.size(12.dp).clip(RoundedCornerShape(3.dp)).background(Dray.onPrimary))
                    }, trailing = { StopTimer(Dictations.since[draft]) }) { Dictations.stop(store, draft) }
                } else {
                    DockButton(if (sending) "" else "Start task", DockKind.Primary, enabled = phase == DockPhase.Ready && ready && !sending,
                        leading = if (sending) ({ CircularProgressIndicator(Modifier.size(16.dp), color = Dray.onPrimary, strokeWidth = 2.dp) }) else null,
                        onClick = onStart)
                }
            }
        }
    }
}

internal enum class DockKind { Plain, Primary, Destructive }

/** The open dock's pill buttons: a plain fill, the primary white, or red for Discard. */
@Composable
internal fun DockButton(
    label: String, kind: DockKind = DockKind.Plain, enabled: Boolean = true,
    leading: (@Composable () -> Unit)? = null, trailing: (@Composable () -> Unit)? = null, onClick: () -> Unit,
) {
    val fill = when (kind) {
        DockKind.Primary -> Dray.primary
        DockKind.Destructive -> Dray.destructive.copy(alpha = 0.18f)
        DockKind.Plain -> Dray.raised
    }
    val ink = when (kind) {
        DockKind.Primary -> Dray.onPrimary
        DockKind.Destructive -> Dray.destructive
        DockKind.Plain -> Dray.text
    }
    Row(
        Modifier.height(48.dp).clip(RoundedCornerShape(24.dp)).background(fill).alpha(if (enabled) 1f else 0.4f)
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 22.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        leading?.invoke()
        if (label.isNotEmpty()) Text(label, style = Dray.Font.pill.copy(color = ink))
        trailing?.invoke()
    }
}

/** How long the microphone has been open, m:ss. */
@Composable
internal fun StopTimer(since: Long?) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(since) { while (since != null) { now = System.currentTimeMillis(); delay(1000) } }
    val s = since?.let { ((now - it) / 1000).coerceAtLeast(0) } ?: 0
    Text("%d:%02d".format(s / 60, s % 60), Modifier.alpha(if (since == null) 0.4f else 1f),
        style = Dray.Font.footnoteStrong.copy(color = Dray.onPrimary.copy(alpha = 0.6f), fontFeatureSettings = "tnum"))
}

/** The words so far, large and dim at the top of the open dock, the newest in view, a tap away from editing. */
@Composable
private fun SpokenText(text: String, modifier: Modifier, edit: () -> Unit) {
    val scroll = rememberScrollState()
    LaunchedEffect(text) { scroll.scrollTo(scroll.maxValue) }
    Box(modifier.fillMaxWidth()) {
        Text(
            text,
            Modifier.fillMaxWidth().verticalScroll(scroll).padding(top = 140.dp, bottom = 24.dp).clickable(onClickLabel = "Edit", onClick = edit),
            style = Dray.Font.title.copy(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.Normal, color = Dray.text.copy(alpha = 0.7f)),
        )
        Box(Modifier.fillMaxWidth().height(180.dp).background(Brush.verticalGradient(listOf(Dray.page, Color.Transparent))))
    }
}

/** What dictation said instead of words, under the resting orb; Retry and Discard beside it while the audio is kept. */
@Composable
internal fun KeptNote(line: String, draft: SessionKey, modifier: Modifier = Modifier) {
    val store = LocalStore.current
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(line, Modifier.weight(1f, fill = false), style = Dray.Font.footnote.copy(color = Dray.tertiary), textAlign = TextAlign.Center)
        if (Dictations.kept[draft] != null) {
            Text("Retry", Modifier.clickable { Dictations.retry(store, draft) }, style = Dray.Font.footnoteStrong)
            Text("Discard", Modifier.clickable { Dictations.dismiss(draft) }, style = Dray.Font.footnoteStrong.copy(color = Dray.destructive))
        }
    }
}

/** The orb's place where nothing can transcribe: a field growing to five lines, with its send beside it. */
@Composable
private fun ChatField(placeholder: String, text: String, change: (String) -> Unit, sending: Boolean, sendable: Boolean, send: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.xl)).background(Dray.card).imePadding(),
        verticalAlignment = Alignment.Bottom,
    ) {
        Box(Modifier.weight(1f).heightIn(min = 44.dp).padding(start = 16.dp, top = 11.dp, bottom = 11.dp)) {
            if (text.isEmpty()) Text(placeholder, style = Dray.Font.body.copy(color = Dray.tertiary))
            BasicTextField(text, change, Modifier.fillMaxWidth().heightIn(max = 120.dp), textStyle = Dray.Font.body, cursorBrush = SolidColor(Dray.text))
        }
        Box(
            Modifier.padding(6.dp).size(32.dp).clip(RoundedCornerShape(16.dp)).background(Dray.text).alpha(if (sendable) 1f else 0.3f)
                .clickable(enabled = sendable, onClickLabel = "Send", onClick = send),
            contentAlignment = Alignment.Center,
        ) {
            if (sending) CircularProgressIndicator(Modifier.size(14.dp), color = Dray.page, strokeWidth = 2.dp)
            else Icon(Icons.Filled.ArrowUpward, null, Modifier.size(18.dp), tint = Dray.page)
        }
    }
}

/** The keyboard's way into the same text: a sheet holding it whole. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TextSheet(title: String, text: String, change: (String) -> Unit, dismiss: () -> Unit) {
    val focus = remember { FocusRequester() }
    ModalBottomSheet(dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Dray.card) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 16.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f), style = Dray.Font.headline)
                Text("Done", Modifier.clickable(onClick = dismiss).padding(8.dp), style = Dray.Font.pill)
            }
            Box(Modifier.fillMaxWidth().heightIn(min = 160.dp, max = 360.dp)) {
                if (text.isEmpty()) Text("What should it do?", style = Dray.Font.body.copy(color = Dray.tertiary))
                BasicTextField(text, change, Modifier.fillMaxWidth().focusRequester(focus), textStyle = Dray.Font.body, cursorBrush = SolidColor(Dray.text))
            }
        }
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
}

/** A swipe up over the resting dock opens the keyboard, as on iOS. */
private fun Modifier.pointerSwipeUp(on: Boolean, action: () -> Unit): Modifier = if (!on) this else pointerInput(Unit) {
    var dragged = 0f
    detectVerticalDragGestures(onDragStart = { dragged = 0f }, onDragEnd = { if (dragged < -60f) action() }) { _, dy -> dragged += dy }
}

/**
 * Runs what it is handed with the microphone allowed, asking Android first where it hasn't been.
 * A refusal is said in the draft's note, where a failed dictation would say it.
 */
@Composable
internal fun rememberWithMic(draft: SessionKey): (() -> Unit) -> Unit {
    val context = LocalContext.current
    var waiting by remember { mutableStateOf<(() -> Unit)?>(null) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val then = waiting
        waiting = null
        if (granted) then?.invoke()
        else Dictations.notes[draft] = "Dray can't use the microphone. Allow it in Android's settings, under Apps, Dray, Permissions."
    }
    return { then ->
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) then()
        else {
            waiting = then
            ask.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
}

/**
 * The list's dock on a stand-in for New task: the first machine up, its most recent project,
 * Claude Code on a model tapped through. Here until the New task port lands its picks and Run with,
 * which take `picks` and `start` over; the dock itself stays.
 */
@Composable
fun NewTaskDock(openSession: (SessionKey) -> Unit, modifier: Modifier = Modifier) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val server = store.live.firstOrNull { store.serverState[it.id] == ConnState.Connected }
    val project = server?.let { s -> store.projects[s.id].orEmpty().maxByOrNull { it.lastSelected } }
    var models by remember { mutableStateOf(emptyList<Model>()) }
    var model by remember { mutableStateOf<Model?>(null) }
    var effort by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(server?.id) {
        models = server?.let { store.models(it.id, "claude_code").filter { m -> m.secondary != true } }.orEmpty()
        model = models.firstOrNull { it.id == Picks.defaultModel["claude_code"] } ?: models.firstOrNull()
        effort = model?.let { Picks.usableEffort(it, Picks.DEFAULT_EFFORT) }
    }
    val text = store.drafts[NewTaskDraft].orEmpty().trim()

    VoiceDock(
        sending = sending,
        ready = text.isNotEmpty() && server != null && project != null && model != null,
        failure = failure,
        clearFailure = { failure = null },
        start = start@{
            val s = server ?: return@start
            val p = project ?: return@start
            val m = model ?: return@start
            sending = true
            failure = null
            scope.launch {
                val id = UUID.randomUUID().toString().lowercase()
                runCatching {
                    store.call(s.id, "send_msg", jsonOf(
                        "sessionId" to id, "prompt" to text, "attachmentPaths" to emptyList<String>(), "harness" to "claude_code",
                        "model" to m.id, "effort" to effort, "permissionMode" to "auto", "fast" to false, "cwd" to p.path,
                        "branch" to null, "useWorktree" to false, "worktreeName" to null, "baseRef" to null, "isNewSession" to true,
                    ))
                }.onSuccess {
                    // Words added while the start was out were never sent, so they stay.
                    if (store.drafts[NewTaskDraft].orEmpty().trim() == text) store.drafts.remove(NewTaskDraft)
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    openSession(SessionKey(s.id, id))
                }.onFailure { failure = sentence(it.message ?: "The server didn't answer.") }
                sending = false
            }
        },
        picks = { edit ->
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier.clickable(enabled = models.size > 1) {
                        model = models[(models.indexOf(model) + 1) % models.size]
                        effort = model?.let { Picks.usableEffort(it, effort) }
                    },
                    horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    AgentMark("claude_code", 13.dp)
                    Text(model?.label ?: "Model", style = Dray.Font.footnoteStrong)
                }
                model?.efforts?.takeIf { it.isNotEmpty() }?.let { efforts ->
                    Text(Picks.effortLabels[effort] ?: effort.orEmpty(), Modifier.clickable {
                        effort = efforts[(efforts.indexOf(effort) + 1) % efforts.size]
                    }, style = Dray.Font.footnote.copy(color = Dray.tertiary))
                }
                Text(server?.name ?: "Machine", style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = 1)
                Text(project?.name ?: "Project", style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = 1)
                if (edit != null) Icon(Icons.Outlined.Keyboard, "Keyboard", Modifier.size(20.dp).clickable(onClick = edit), tint = Dray.secondary)
            }
        },
        modifier = modifier,
    )
}
