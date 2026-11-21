package com.yogesh.dray.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.Blobatar
import com.yogesh.dray.model.Model
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.store.AgentPick
import com.yogesh.dray.store.botChat
import com.yogesh.dray.wire.Bot
import com.yogesh.dray.wire.BotAvatar
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.arr
import com.yogesh.dray.wire.bool
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.face
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.str
import kotlinx.coroutines.launch

/** One agent `agent_availability` lists. */
private data class Agent(val harness: String, val label: String, val available: Boolean)

/** `usableModel`: the pick where the list has it, else the agent's default, else the list's first. */
private fun usableModel(models: List<Model>, picked: String, harness: String): String {
    if (models.isEmpty() || models.any { it.id == picked }) return picked
    val fallback = Picks.defaultModel[harness].orEmpty()
    if (fallback.isEmpty()) return ""
    return if (models.any { it.id == fallback }) fallback else models[0].id
}

/**
 * The desktop's New bot / Edit bot dialog, iOS's `BotSheet`: a face, a name, a shape and a colour,
 * with the agent and model it runs on. A new bot also picks its machine and starts its chat on
 * them, the bot speaking first. Editing says where it runs; its agent and model go with the chat's
 * next message, another agent moving the chat to a new session. With no new-task dock to borrow
 * them from, a new bot's effort is picked here too.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun BotSheet(editing: Pair<String, Bot>?, close: () -> Unit, started: (SessionKey) -> Unit = {}) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val connected = store.live.filter { store.serverState[it.id] == ConnState.Connected }
    val chatOf = editing?.let { (s, b) -> store.botChat(s, b).lastOrNull() }

    var name by remember { mutableStateOf(editing?.second?.name ?: "") }
    var avatar by remember { mutableStateOf(editing?.second?.face ?: Blobatar.defaultAvatar) }
    var server by remember { mutableStateOf(editing?.first ?: connected.firstOrNull()?.id) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    /** A bot made whose chat failed to start: a retry starts that one, never a second bot. */
    var made by remember { mutableStateOf<Bot?>(null) }
    // An edit opens on the chat's pick: one waiting for its next message, else what it runs on.
    val opening = chatOf?.let { store.botState.unsent[it] ?: store.items[it]?.let { i -> AgentPick(i.harness, i.model) } }
    var harness by remember { mutableStateOf(opening?.harness ?: "claude_code") }
    var modelId by remember { mutableStateOf(opening?.model ?: Picks.defaultModel["claude_code"].orEmpty()) }
    var effort by remember { mutableStateOf<String?>(null) }
    var agents by remember { mutableStateOf(emptyList<Agent>()) }
    var models by remember { mutableStateOf(emptyList<Model>()) }
    var allModels by remember { mutableStateOf(false) }
    var serverMenu by remember { mutableStateOf(false) }
    val target = server

    // The agents up on the bot's machine, then the picked one's models, each read checked against the pick it was for.
    LaunchedEffect(target) {
        target ?: return@LaunchedEffect
        agents = runCatching { store.call(target, "agent_availability").arr }.getOrDefault(emptyList()).mapNotNull {
            Agent(it["harness"].str ?: return@mapNotNull null, it["label"].str ?: "", it["available"].bool ?: false)
        }
        if (agents.none { it.harness == harness && it.available }) agents.firstOrNull { it.available }?.let { harness = it.harness; modelId = "" }
    }
    LaunchedEffect(target, harness) {
        target ?: return@LaunchedEffect
        val read = runCatching { decodeList<Model>(store.call(target, "list_models", jsonOf("harness" to harness))) }.getOrDefault(emptyList())
        models = read
        modelId = usableModel(read, modelId.ifEmpty { Picks.defaultModel[harness].orEmpty() }, harness)
    }

    suspend fun submit() {
        val trimmed = name.trim()
        val at = target ?: return
        if (trimmed.isEmpty() || busy) return
        busy = true
        error = null
        try {
            val face = jsonOf("shape" to avatar.shape, "hue" to avatar.hue)
            if (editing != null) {
                store.call(at, "edit_bot", jsonOf("id" to editing.second.id, "name" to trimmed, "avatar" to face))
                val item = chatOf?.let { store.items[it] }
                if (chatOf != null && item != null) {
                    val pick = AgentPick(harness, modelId)
                    if (pick == AgentPick(item.harness, item.model)) store.botState.unsent.remove(chatOf) else store.botState.unsent[chatOf] = pick
                }
                store.loadBots(at)
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                close()
            } else {
                var bot = made ?: create(store, at, trimmed, face).also { made = it }
                // A retry carries what was changed since onto the bot made.
                if (bot.name != trimmed || bot.face != avatar) {
                    bot = decodeOrNull<Bot>(store.call(at, "edit_bot", jsonOf("id" to bot.id, "name" to trimmed, "avatar" to face))) ?: bot
                    made = bot
                }
                // A start whose reply was lost may have opened the chat anyway: open that one, never a second.
                store.loadBots(at)
                val open = store.botChat(at, bot).lastOrNull()
                val key = open ?: run {
                    val model = models.firstOrNull { it.id == modelId }
                    val chat = decodeOrNull<SessionItem>(store.call(at, "start_bot", jsonOf(
                        "id" to bot.id, "harness" to harness, "model" to modelId,
                        "effort" to model?.let { Picks.usableEffort(it, effort) },
                        "permissionMode" to Picks.stanceFor(harness, "auto"), "fast" to false,
                    ))) ?: throw com.yogesh.dray.wire.DrayError("The bot's chat didn't start.")
                    store.created(at, chat)
                    SessionKey(at, chat.sessionId)
                }
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                close()
                started(key)
            }
        } catch (e: Exception) {
            error = e.message ?: "Couldn't save the bot."
        } finally {
            busy = false
        }
    }

    ModalBottomSheet({ if (!busy) close() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Dray.card) {
        Column(Modifier.imePadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Cancel", Modifier.clip(CircleShape).clickable(enabled = !busy, onClick = close).padding(12.dp), style = Dray.Font.body.copy(color = Dray.secondary))
                Text(if (editing == null) "New bot" else "Edit bot", Modifier.weight(1f), style = Dray.Font.headline, textAlign = TextAlign.Center)
                val ready = name.isNotBlank() && !busy && target != null && harness.isNotEmpty()
                Box(Modifier.clip(CircleShape).clickable(enabled = ready) { scope.launch { submit() } }.padding(12.dp)) {
                    if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = Dray.text, strokeWidth = 2.dp)
                    else Text(if (editing == null) "Create" else "Save", style = Dray.Font.pill.copy(color = if (ready) Dray.text else Dray.tertiary))
                }
            }
            Column(
                Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(top = 8.dp, bottom = 32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                // A fixed seed, so the faces differ by shape and colour alone, as on the desktop.
                BotFace("new-bot", avatar, 96.dp)
                Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.raised).padding(vertical = 12.dp, horizontal = 16.dp), contentAlignment = Alignment.Center) {
                    if (name.isEmpty()) Text("Name your bot", style = Dray.Font.headline.copy(color = Dray.tertiary))
                    BasicTextField(
                        name, { name = it }, Modifier.fillMaxWidth().semantics { contentDescription = "Bot name" },
                        textStyle = Dray.Font.headline.copy(textAlign = TextAlign.Center), singleLine = true,
                        cursorBrush = SolidColor(Dray.text), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    )
                }
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalArrangement = Arrangement.spacedBy(8.dp), maxItemsInEachRow = 5) {
                    for ((shape, _) in Blobatar.shapes) {
                        val on = avatar.shape == shape
                        Box(
                            Modifier.size(52.dp).clip(CircleShape).border(2.dp, Dray.text.copy(alpha = if (on) 0.6f else 0f), CircleShape)
                                .clickable { avatar = BotAvatar(shape, avatar.hue) }.semantics { contentDescription = shape; selected = on },
                            contentAlignment = Alignment.Center,
                        ) { BotFace("new-bot", BotAvatar(shape, avatar.hue), 36.dp) }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for ((label, hue) in Blobatar.hues) {
                        val on = avatar.hue == hue
                        Box(
                            Modifier.size(34.dp).clip(CircleShape).border(2.dp, Dray.text.copy(alpha = if (on) 0.7f else 0f), CircleShape).padding(3.dp)
                                .clip(CircleShape).background(Color(Blobatar.swatch(hue))).clickable { avatar = BotAvatar(avatar.shape, hue) }
                                .semantics { contentDescription = label; selected = on },
                        )
                    }
                }
                val up = agents.filter { it.available }
                if (up.isNotEmpty()) PickRow("Agent") {
                    for (a in up) PickChip(a.label.ifEmpty { Picks.agentLabels[a.harness] ?: a.harness }, a.harness == harness) {
                        if (a.harness != harness) { harness = a.harness; modelId = ""; models = emptyList() }
                    }
                }
                val shown = if (allModels) models else models.filter { it.secondary != true || it.id == modelId }
                PickRow("Model", note = pickNote(editing, chatOf, harness, modelId)) {
                    if (Picks.defaultModel[harness] == "") PickChip("Default", modelId.isEmpty()) { modelId = "" }
                    for (m in shown) PickChip(m.label, m.id == modelId) { modelId = m.id; effort = null }
                    if (!allModels && models.any { it.secondary == true }) PickChip("More models", false) { allModels = true }
                }
                // A new bot's chat starts at this effort; an edit's is the reply dock's to change.
                val model = models.firstOrNull { it.id == modelId }
                if (editing == null && model != null && model.efforts.isNotEmpty()) PickRow("Effort") {
                    val current = Picks.usableEffort(model, effort)
                    for (e in model.efforts) PickChip(Picks.effortLabels[e] ?: e, e == current) { effort = e }
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Runs on", style = Dray.Font.footnote.copy(color = Dray.tertiary))
                    val pickable = editing == null && connected.size > 1 && made == null
                    Box {
                        Row(
                            Modifier.clip(CircleShape).clickable(enabled = pickable) { serverMenu = true }.padding(horizontal = 8.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Icon(Icons.Outlined.Dns, null, Modifier.size(13.dp), tint = Dray.secondary)
                            Text(target?.let { store.name(it) } ?: "No server connected", style = Dray.Font.subhead.copy(color = Dray.secondary))
                            if (pickable) Icon(Icons.Filled.UnfoldMore, null, Modifier.size(14.dp), tint = Dray.secondary)
                        }
                        DropdownMenu(serverMenu, { serverMenu = false }, containerColor = Dray.raised) {
                            for (s in connected) DropdownMenuItem({ Text(s.name) }, onClick = { server = s.id; serverMenu = false })
                        }
                    }
                }
                error?.let { Text(sentence(it), style = Dray.Font.subhead.copy(color = Dray.destructive), textAlign = TextAlign.Center) }
            }
        }
    }
}

/** When an edit's pick lands: with the next message, another agent moving the chat. */
@Composable
private fun pickNote(editing: Pair<String, Bot>?, chat: SessionKey?, harness: String, model: String): String? {
    val item = chat?.let { LocalStore.current.items[it] } ?: return null
    editing ?: return null
    if (harness != item.harness) return "Your next message moves the chat to ${Picks.agentLabels[harness] ?: harness}."
    return if (model != item.model) "Goes with your next message." else null
}

/**
 * `create_bot`, and where it fails, the bot of this name that appeared during the call: one a lost
 * reply made. A bot there before is a refused name, never adopted.
 */
private suspend fun create(store: com.yogesh.dray.store.Store, at: String, name: String, face: kotlinx.serialization.json.JsonObject): Bot {
    val before = decodeList<Bot>(store.call(at, "list_bots")).map { it.id }.toSet()
    return try {
        decodeOrNull<Bot>(store.call(at, "create_bot", jsonOf("name" to name, "avatar" to face))) ?: throw com.yogesh.dray.wire.DrayError("The bot wasn't made.")
    } catch (e: Exception) {
        decodeList<Bot>(runCatching { store.call(at, "list_bots") }.getOrNull()).firstOrNull {
            it.id !in before && it.name.equals(name, ignoreCase = true) && store.botChat(at, it).isEmpty()
        } ?: throw e
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PickRow(title: String, note: String? = null, chips: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = Dray.Font.footnote.copy(color = Dray.tertiary))
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) { chips() }
        note?.let { Text(it, style = Dray.Font.footnote.copy(color = Dray.tertiary)) }
    }
}

@Composable
private fun PickChip(label: String, picked: Boolean, onClick: () -> Unit) {
    Text(
        label,
        Modifier.clip(CircleShape).background(if (picked) Dray.primary else Dray.tile).clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp).semantics { selected = picked },
        style = Dray.Font.pill.copy(color = if (picked) Dray.onPrimary else Dray.text),
    )
}
