package com.yogesh.dray.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.Model
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.store.botSend
import com.yogesh.dray.voice.Dictation
import com.yogesh.dray.voice.Dictations
import com.yogesh.dray.voice.dictationEngine
import com.yogesh.dray.voice.typesOnly
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What the reader moved for the next reply; null keeps the session's own. */
private data class ReplyPicks(val model: String? = null, val effort: String? = null, val stance: String? = null, val fast: Boolean? = null)

/**
 * The reply dock at a session's foot: a message field that sends, and under it the session's
 * picks for the next reply, and Stop while a turn runs. The iOS dock is voice-first; here the
 * field leads, as Android chat does, with Dray's own dictation (`Dictations`) one tap away.
 */
@Composable
fun ReplyDock(key: SessionKey) {
    val store = LocalStore.current
    val item = store.items[key] ?: return
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    var picks by remember(key) { mutableStateOf(ReplyPicks()) }
    var sending by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf<String?>(null) }
    var sheet by remember { mutableStateOf(false) }
    var models by remember { mutableStateOf(emptyList<Model>()) }
    val connected = store.serverState[key.server] == ConnState.Connected
    val away = key.server in store.lost
    val draft = store.drafts[key].orEmpty()
    // A bot chat's agent and model from its sheet, waiting for this reply; another agent moves the chat.
    val pick = store.botState.unsent[key]
    val moving = pick != null && pick.harness != item.harness
    val harness = pick?.harness ?: item.harness

    LaunchedEffect(key.server, harness, connected) {
        if (connected) models = store.models(key.server, harness)
    }

    val modelId = picks.model ?: pick?.model ?: item.model
    val model = models.firstOrNull { it.id == modelId }
    val effort = picks.effort ?: if (moving) null else item.effort
    val dictation = Dictations.state(key)
    val listening = dictation != Dictation.Idle
    // Nothing on the phone or any server can transcribe: the mic goes, and the field is the dock.
    val canDictate = !store.typesOnly
    val withMic = rememberWithMic(key)
    var hint by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(hint) { if (hint != null) { delay(2000); hint = null } }
    // Leaving mid-recording sends what was said into this session's draft, the desktop's rule.
    DisposableEffect(key) { onDispose { if (Dictations.state(key) == Dictation.Recording) Dictations.stop(store, key) } }

    fun dictate() {
        if (dictation == Dictation.Recording) return Dictations.stop(store, key)
        if (listening) return
        val engine = store.dictationEngine() ?: run { hint = "Nothing can transcribe right now. Type instead."; return }
        // A kept recording is the only copy of what was said; it goes by Retry or Discard, never by a new tap.
        if (Dictations.kept[key] != null) return
        Dictations.dismiss(key)
        failed = null
        withMic {
            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            Dictations.start(store, engine, key)
        }
    }

    fun send() {
        val text = draft.trim()
        // Spoken words still on their way would land after this send, as a reply of their own.
        if (text.isEmpty() || sending || !connected || listening) return
        sending = true
        failed = null
        scope.launch {
            // Effort goes only where the reader moved it, coerced to a rung the model has.
            val moved = picks.model != null || picks.effort != null || pick != null
            val level = if (moved) model?.let { Picks.usableEffort(it, effort) } ?: effort else null
            val ok = if (store.bot(key) != null) {
                store.botSend(key, text, pick?.harness, picks.model ?: pick?.model, level, picks.stance, picks.fast) != null
            } else {
                store.send(key, text, picks.model, level, picks.stance, picks.fast, effortMoved = moved)
            }
            sending = false
            if (ok) {
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                // Words typed while the send was out stay.
                if (store.drafts[key] == draft) store.drafts.remove(key)
                picks = ReplyPicks()
            } else {
                failed = store.lastError ?: "The server didn't answer."
                store.lastError = null
            }
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(Dray.page)
            .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 8.dp)
            .alpha(if (away) 0.4f else 1f),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (moving) Text(
            "Your next message moves this chat to ${Picks.agentLabels[harness] ?: harness}.",
            style = Dray.Font.footnote.copy(color = Dray.tertiary),
        )
        failed?.let {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Couldn't send. ${sentence(it)}", Modifier.weight(1f), style = Dray.Font.footnote.copy(color = Dray.destructive))
                Text("Retry", Modifier.clickable { send() }, style = Dray.Font.footnoteStrong)
            }
        }
        (hint ?: Dictations.notes[key])?.let { KeptNote(it, key, Modifier.padding(horizontal = 4.dp)) }
        if (listening) ListeningRow(key) else Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 44.dp)
                    .clip(RoundedCornerShape(Dray.Radius.xl))
                    .background(Dray.card)
                    .border(1.dp, Dray.hairline, RoundedCornerShape(Dray.Radius.xl))
                    .padding(horizontal = 16.dp, vertical = 11.dp),
            ) {
                if (draft.isEmpty()) Text("Message", style = Dray.Font.body.copy(color = Dray.tertiary))
                BasicTextField(
                    draft,
                    { if (it.isEmpty()) store.drafts.remove(key) else store.drafts[key] = it },
                    // Room on the right for the mic that adds to words already there.
                    Modifier.fillMaxWidth().heightIn(max = 160.dp).padding(end = if (draft.isNotBlank() && canDictate) 28.dp else 0.dp),
                    textStyle = Dray.Font.body,
                    cursorBrush = SolidColor(Dray.text),
                )
                if (draft.isNotBlank() && canDictate) {
                    Icon(Icons.Outlined.Mic, "Dictate", Modifier.align(Alignment.BottomEnd).size(22.dp).clickable(onClick = ::dictate), tint = Dray.secondary)
                }
            }
            val ready = draft.isNotBlank() && !sending && connected
            if (draft.isBlank() && canDictate) {
                RoundButton(Dray.raised, "Dictate", onClick = ::dictate) { Icon(Icons.Outlined.Mic, null, tint = Dray.text) }
            } else {
                RoundButton(if (ready) Dray.primary else Dray.raised, "Send", enabled = ready, onClick = ::send) {
                    if (sending) CircularProgressIndicator(Modifier.size(18.dp), color = Dray.onPrimary, strokeWidth = 2.dp)
                    else Icon(Icons.Filled.ArrowUpward, null, tint = if (ready) Dray.onPrimary else Dray.tertiary)
                }
            }
        }
        Row(Modifier.height(28.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(Modifier.clickable { sheet = true }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                AgentMark(harness, 13.dp)
                Text(model?.label ?: modelId.ifEmpty { Picks.agentLabels[harness] ?: harness }, style = Dray.Font.footnoteStrong)
                effort?.let { Text(Picks.effortLabels[it] ?: it, style = Dray.Font.footnote.copy(color = Dray.tertiary)) }
            }
            Text("···", Modifier.clickable { sheet = true }, style = Dray.Font.footnoteStrong.copy(color = Dray.secondary))
            Spacer(Modifier.weight(1f))
            if (item.busy) {
                Box(
                    Modifier.size(28.dp).clip(CircleShape).background(Dray.raised).clickable {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        store.interrupt(key)
                    },
                    contentAlignment = Alignment.Center,
                ) { Box(Modifier.size(10.dp).clip(RoundedCornerShape(2.dp)).background(Dray.text)) }
            }
        }
    }

    if (sheet) ThisTaskSheet(harness, item.busy, models, modelId, effort, picks.stance ?: item.permissionMode,
        picks.fast ?: item.fast ?: false, onModel = { picks = picks.copy(model = it, effort = null) },
        onEffort = { picks = picks.copy(effort = it) }, onStance = { picks = picks.copy(stance = it) },
        onFast = { picks = picks.copy(fast = it) }) { sheet = false }
}

/**
 * The field's place while the microphone is open: Cancel, the orb with how long it has listened,
 * and Done; then the orb curling while the words are read.
 */
@Composable
private fun ListeningRow(key: SessionKey) {
    val store = LocalStore.current
    val dictation = Dictations.state(key)
    Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        RoundButton(Dray.raised, "Cancel", onClick = { Dictations.cancel(key) }) { Icon(Icons.Filled.Close, null, tint = Dray.text) }
        DockOrb(key, 44.dp, tap = { if (dictation == Dictation.Recording) Dictations.stop(store, key) })
        Text(
            if (dictation == Dictation.Transcribing) "Transcribing…" else "Listening",
            Modifier.weight(1f),
            style = Dray.Font.subhead.copy(color = Dray.secondary),
        )
        if (dictation != Dictation.Transcribing) {
            DockButton("Done", DockKind.Primary, enabled = dictation == Dictation.Recording, leading = {
                Box(Modifier.size(10.dp).clip(RoundedCornerShape(2.dp)).background(Dray.onPrimary))
            }, trailing = { StopTimer(Dictations.since[key]) }) { Dictations.stop(store, key) }
        }
    }
}

@Composable
private fun RoundButton(fill: androidx.compose.ui.graphics.Color, label: String, enabled: Boolean = true, onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        Modifier.size(44.dp).clip(CircleShape).background(fill).clickable(enabled = enabled, onClickLabel = label, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { content() }
}

/**
 * This task: the session's model, effort, fast mode and stance for the next reply, each locked
 * mid-turn where the harness can't carry it onto a queued prompt. Nothing reaches the session
 * until a reply goes out, since `send_msg` is what carries it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ThisTaskSheet(
    harness: String, busy: Boolean, models: List<Model>, model: String, effort: String?, stance: String, fast: Boolean,
    onModel: (String) -> Unit, onEffort: (String) -> Unit, onStance: (String) -> Unit, onFast: (Boolean) -> Unit, dismiss: () -> Unit,
) {
    val picked = models.firstOrNull { it.id == model }
    ModalBottomSheet(dismiss, containerColor = Dray.card) {
        Column(Modifier.padding(start = 20.dp, end = 20.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text("This task", style = Dray.Font.title)
            val locked = { c: String -> Picks.lockedMidTurn(harness, c, busy) }
            Section("Model", locked("model")) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val shown = models.filter { it.secondary != true || it.id == model }
                    for (m in shown) Chip(m.label, m.id == model) { onModel(m.id) }
                    if (shown.isEmpty()) Chip(model.ifEmpty { "Default" }, true) {}
                }
            }
            picked?.takeIf { it.efforts.isNotEmpty() }?.let { m ->
                Section("Effort", locked("effort")) {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        val current = Picks.usableEffort(m, effort)
                        for (e in m.efforts) Chip(Picks.effortLabels[e] ?: e, e == current) { onEffort(e) }
                    }
                }
            }
            if (Picks.offersFast(harness, picked)) {
                Row(Modifier.fillMaxWidth().alpha(if (locked("fast")) 0.35f else 1f), verticalAlignment = Alignment.CenterVertically) {
                    Text("Fast mode", Modifier.weight(1f), style = Dray.Font.body)
                    Switch(fast, onFast, enabled = !locked("fast"), colors = SwitchDefaults.colors(
                        checkedTrackColor = Dray.primary, checkedThumbColor = Dray.onPrimary, uncheckedTrackColor = Dray.off,
                        uncheckedThumbColor = Dray.secondary, uncheckedBorderColor = Dray.off))
                }
            }
            if (Picks.offersStances(harness)) {
                Section("Permissions", locked("stance")) {
                    Column(Modifier.clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.raised)) {
                        for ((mode, label) in Picks.stances.filter { Picks.honours(harness, it.first) }) {
                            Row(Modifier.fillMaxWidth().clickable { onStance(mode) }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(label, Modifier.weight(1f), style = Dray.Font.body)
                                if (mode == Picks.stanceFor(harness, stance)) Icon(Icons.Filled.Check, null, Modifier.size(18.dp), tint = Dray.text)
                            }
                        }
                    }
                }
            }
            val lockedNames = listOf("model" to "Model", "effort" to "Effort", "fast" to "Fast mode", "stance" to "Permissions").filter { locked(it.first) }
            if (busy && lockedNames.isNotEmpty()) {
                Text(
                    if (lockedNames.size == 4) "These can change once this turn ends."
                    else "${lockedNames.joinToString(" and ") { it.second }} can change once this turn ends. The rest go with your next message.",
                    style = Dray.Font.footnote.copy(color = Dray.tertiary),
                )
            }
        }
    }
}

@Composable
private fun Section(title: String, locked: Boolean, content: @Composable () -> Unit) {
    Column(Modifier.alpha(if (locked) 0.35f else 1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = Dray.Font.footnote.copy(color = Dray.tertiary))
        // Locked swallows every touch before the chips see it.
        Box(if (!locked) Modifier else Modifier.pointerInput(Unit) {
            awaitPointerEventScope {
                while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
            }
        }) { content() }
    }
}

@Composable
private fun Chip(label: String, picked: Boolean, onClick: () -> Unit) {
    Text(
        label,
        Modifier.clip(CircleShape).background(if (picked) Dray.primary else Dray.tile).clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        style = Dray.Font.pill.copy(color = if (picked) Dray.onPrimary else Dray.text),
    )
}
