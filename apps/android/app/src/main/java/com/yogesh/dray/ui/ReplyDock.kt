package com.yogesh.dray.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Keyboard
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.Model
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.store.AgentPick
import com.yogesh.dray.store.botSend
import com.yogesh.dray.store.rememberedModel
import com.yogesh.dray.voice.Dictation
import com.yogesh.dray.voice.Dictations
import com.yogesh.dray.voice.dictationEngine
import com.yogesh.dray.voice.typesOnly
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What the reader moved for the next reply; null keeps the session's own. */
private data class ReplyPicks(val model: String? = null, val effort: String? = null, val stance: String? = null, val fast: Boolean? = null)

/**
 * The reply dock at a session's foot, as iOS has it: the voice orb, tapped to talk, the words
 * waiting as the bubble they will send as, and under it the session's picks for the next reply,
 * the keyboard and Stop while a turn runs. ReplyDock.swift.
 */
@Composable
fun ReplyDock(key: SessionKey) {
    val store = LocalStore.current
    val item = store.items[key] ?: return
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    // A move to another agent drops picks made for the one it left.
    var picks by remember(key, item.harness) { mutableStateOf(ReplyPicks()) }
    var sending by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf<String?>(null) }
    var sheet by remember { mutableStateOf(false) }
    // Tagged with the agent they were read for, so a pick is never judged against the last agent's list.
    var modelsOf by remember { mutableStateOf("" to emptyList<Model>()) }
    var agents by remember { mutableStateOf(emptyList<com.yogesh.dray.model.AgentAvailability>()) }
    val connected = store.serverState[key.server] == ConnState.Connected
    val away = key.server in store.lost
    val draft = store.drafts[key].orEmpty()
    // The agent and model picked for this reply. Another agent moves the chat: a task in place
    // through `switch_agent`, a bot chat to a new session.
    val pick = store.botState.unsent[key]
    val moving = pick != null && pick.harness != item.harness
    val harness = pick?.harness ?: item.harness
    val models = if (modelsOf.first == harness) modelsOf.second else emptyList()

    LaunchedEffect(key.server, harness, connected) {
        if (connected) modelsOf = harness to store.models(key.server, harness)
    }
    LaunchedEffect(key.server, sheet, connected) {
        if (sheet && connected) agents = store.agents(key.server)
    }

    val modelId = (picks.model ?: pick?.model ?: item.model).let { if (moving) Picks.usableModel(models, it, harness) else it }
    val model = models.firstOrNull { it.id == modelId }
    val effort = picks.effort ?: if (moving) null else item.effort
    val dictation = Dictations.state(key)
    val listening = dictation != Dictation.Idle
    // Nothing on the phone or any server can transcribe: the mic goes, and the field is the dock.
    // Leaving mid-recording sends what was said into this session's draft, the desktop's rule.
    DisposableEffect(key) { onDispose { if (Dictations.state(key) == Dictation.Recording) Dictations.stop(store, key) } }

    fun send() {
        val text = draft.trim()
        // Spoken words still on their way would land after this send, as a reply of their own.
        if (text.isEmpty() || sending || !connected || Dictations.state(key) != Dictation.Idle) return
        sending = true
        failed = null
        scope.launch {
            // Effort goes only where the reader moved it, coerced to a rung the model has.
            val moved = picks.model != null || picks.effort != null || pick != null
            val level = if (moved) model?.let { Picks.usableEffort(it, effort) } ?: effort else null
            val chosen = if (moving) modelId else picks.model ?: pick?.model
            val ok = if (store.bot(key) != null) {
                store.botSend(key, text, pick?.harness, chosen, level, picks.stance, picks.fast) != null
            } else {
                store.send(key, text, chosen, level, picks.stance, picks.fast, effortMoved = moved, harness = pick?.harness)
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

    VoiceDock(
        sending = sending,
        ready = draft.isNotBlank() && connected && !sending,
        failure = failed?.let { "Couldn't send. ${sentence(it)}" },
        clearFailure = { failed = null },
        start = ::send,
        picks = { edit ->
            Row(Modifier.height(28.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Row(Modifier.clickable { sheet = true }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    AgentMark(harness, 13.dp)
                    Text(model?.label ?: modelId.ifEmpty { Picks.agentLabels[harness] ?: harness }, style = Dray.Font.footnoteStrong)
                    effort?.let { Text(Picks.effortLabels[it] ?: it, style = Dray.Font.footnote.copy(color = Dray.tertiary)) }
                }
                Text("···", Modifier.clickable { sheet = true }, style = Dray.Font.footnoteStrong.copy(color = Dray.secondary))
                edit?.let { Icon(Icons.Outlined.Keyboard, "Type", Modifier.clip(CircleShape).clickable(onClick = it).padding(2.dp).size(20.dp), tint = Dray.secondary) }
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
        },
        modifier = Modifier.alpha(if (away) 0.4f else 1f),
        draft = key,
        words = DockWords.Reply,
        covers = false,
        header = if (!moving) null else ({
            Row(Modifier.padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                AgentMark(harness, 13.dp)
                Text(
                    "Your next message goes to ${Picks.agentLabels[harness] ?: harness}",
                    style = Dray.Font.footnote.copy(fontWeight = FontWeight.Medium),
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }),
    )

    // The agents up on the machine, and always the session's own, so a pick can be taken back.
    val choices = agents.filter { it.available }.map { it.harness }.let { up -> if (item.harness in up) up else listOf(item.harness) + up }
    val context = LocalContext.current
    if (sheet) ThisTaskSheet(harness, item.harness, item.busy, choices, models, modelId, effort,
        picks.stance ?: item.permissionMode, picks.fast ?: item.fast ?: false,
        onAgent = { to ->
            // Back on its own agent is no move; another starts on the model last started a task on here.
            if (to == item.harness) store.botState.unsent.remove(key)
            else store.botState.unsent[key] = AgentPick(to, rememberedModel(context, to))
            picks = picks.copy(model = null, effort = null)
        },
        onModel = { picks = picks.copy(model = it, effort = null) },
        onEffort = { picks = picks.copy(effort = it) }, onStance = { picks = picks.copy(stance = it) },
        onFast = { picks = picks.copy(fast = it) }) { sheet = false }
}

/**
 * This task: the session's agent, model, effort, fast mode and stance for the next reply, each
 * locked mid-turn where the harness can't carry it onto a queued prompt. Nothing reaches the
 * session until a reply goes out, since `send_msg` (and `switch_agent`) is what carries it.
 * Another agent is held mid-turn, since a move stops the agent running it; the session's own
 * stays open, so a pick made before the turn can be taken back. ReplyDock.swift's `thisTask`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ThisTaskSheet(
    harness: String, own: String, busy: Boolean, agents: List<String>, models: List<Model>, model: String,
    effort: String?, stance: String, fast: Boolean, onAgent: (String) -> Unit,
    onModel: (String) -> Unit, onEffort: (String) -> Unit, onStance: (String) -> Unit, onFast: (Boolean) -> Unit, dismiss: () -> Unit,
) {
    val picked = models.firstOrNull { it.id == model }
    // One agent is no choice.
    val offersAgents = agents.size > 1
    var library by remember { mutableStateOf(false) }
    ModalBottomSheet(dismiss, containerColor = Dray.card) {
        if (library) {
            ModelLibrary(models, harness) { library = false }
            return@ModalBottomSheet
        }
        Column(Modifier.padding(start = 20.dp, end = 20.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text("This task", style = Dray.Font.title)
            val locked = { c: String -> Picks.lockedMidTurn(harness, c, busy) }
            if (offersAgents) Section("Agent", false) {
                ChipRow(focus = agents.indexOf(harness)) {
                    items(agents, key = { it }) { a ->
                        val held = locked("agent") && a != own
                        Box(Modifier.alpha(if (held) 0.35f else 1f)) {
                            PickChip(Picks.agentLabels[a] ?: a, a == harness, harness = a) { if (!held && a != harness) onAgent(a) }
                        }
                    }
                }
            }
            Section("Model", locked("model")) {
                ModelChips(models, harness, model, onModel) { library = true }
            }
            picked?.takeIf { it.efforts.isNotEmpty() }?.let { m ->
                Section("Effort", locked("effort")) {
                    val current = Picks.usableEffort(m, effort)
                    ChipRow(focus = m.efforts.indexOf(current)) {
                        items(m.efforts, key = { it }) { e -> PickChip(Picks.effortLabels[e] ?: e, e == current) { onEffort(e) } }
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
            val controls = (if (offersAgents) listOf("agent" to "Agent") else emptyList()) +
                listOf("model" to "Model", "effort" to "Effort", "fast" to "Fast mode", "stance" to "Permissions")
            val lockedNames = controls.filter { locked(it.first) }
            if (busy && lockedNames.isNotEmpty()) {
                Text(
                    if (lockedNames.size == controls.size) "These can change once this turn ends."
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
