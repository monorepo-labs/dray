package com.yogesh.dray.ui

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Share
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.AgentAvailability
import com.yogesh.dray.model.Model
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.PrCheckout
import com.yogesh.dray.model.ProjectKey
import com.yogesh.dray.store.rememberedModel
import com.yogesh.dray.wire.Bot
import com.yogesh.dray.wire.Project
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.jsonOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.io.File

/** A detail page's top-bar actions: Share, then Play, the primary one, at the right end. */
@Composable
fun StartActions(share: (() -> Unit)?, start: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dray.Space.xs)) {
        share?.let { IconButton(it) { Icon(Icons.Filled.Share, "Share", Modifier.size(20.dp), tint = Dray.text) } }
        Box(
            Modifier.size(36.dp).clip(CircleShape).background(Dray.primary).clickable(onClick = start),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.PlayArrow, "Start a task", Modifier.size(22.dp), tint = Dray.onPrimary) }
    }
}

/** Android's share sheet with a title and its link, the way a browser shares a page. */
fun shareLink(context: Context, title: String, url: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, title)
        putExtra(Intent.EXTRA_TITLE, title)
        putExtra(Intent.EXTRA_TEXT, if (title.isEmpty()) url else "$title\n$url")
    }
    context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

/** The sheet a detail page's Play opens: a title over the start box, scrolling, kept above the keyboard. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StartSheet(title: String, dismiss: () -> Unit, content: @Composable () -> Unit) {
    ModalBottomSheet(
        dismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Dray.card,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
    ) {
        Column(Modifier.imePadding().padding(horizontal = Dray.Space.l)) {
            Box(Modifier.fillMaxWidth().height(44.dp), contentAlignment = Alignment.Center) {
                Text(title, style = Dray.Font.headline, maxLines = 1)
            }
            Column(Modifier.verticalScroll(rememberScrollState()).padding(top = Dray.Space.s, bottom = Dray.Space.xl)) { content() }
        }
    }
}

/** Everything Start was pressed on: where, which bot if any, the agent's picks and the reader's words. */
class StartPick(
    val server: String,
    /** The checkout, attached or cloned by now; null for a bot that needs none. */
    val cwd: String?,
    val bot: Bot?,
    val text: String,
    val harness: String,
    val model: String,
    val effort: String?,
    val fast: Boolean,
    val worktree: Boolean,
)

/**
 * The box a task starts from on a PR's or an issue's page: a bot or the reader's own task, the
 * plain task's place, agent, model, effort and fast mode, the reader's words, and Start. A bot
 * runs on its own agent, so the pickers belong to the plain task alone. A checkout picked as a
 * clone or one to attach is made only on Start, so opening the sheet changes nothing on disk.
 * [prefsKey] keeps each page's bot pick apart; [botCheckout] says a bot's task still needs one.
 */
@Composable
fun StartBox(
    prefsKey: String,
    text: String,
    setText: (String) -> Unit,
    placeholder: String,
    placeLabel: String,
    machines: List<PrCheckout>,
    initial: PrCheckout?,
    /** `owner/name` a clone checks out, and the remote key the clone lands under. */
    clone: Pair<String, String>?,
    bots: List<Pair<String, Bot>>,
    botCheckout: Boolean,
    latest: SessionItem?,
    worktreeSwitch: Boolean,
    note: (@Composable () -> Unit)? = null,
    run: suspend (StartPick) -> Unit,
    started: (StartPick) -> Unit,
) {
    val store = LocalStore.current
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val prefs = remember { context.getSharedPreferences("store", Context.MODE_PRIVATE) }
    val newPrefs = remember { context.getSharedPreferences("new", Context.MODE_PRIVATE) }
    var mode by remember { mutableStateOf(prefs.getString("$prefsKey.startMode", "bot")!!) }
    var botId by remember { mutableStateOf(prefs.getString("$prefsKey.startBot", "").orEmpty()) }
    var machine by remember { mutableStateOf<PrCheckout?>(null) }
    var harness by remember { mutableStateOf("") }
    var modelId by remember { mutableStateOf("") }
    var effort by remember { mutableStateOf<String?>(null) }
    var fast by remember { mutableStateOf(false) }
    var worktree by remember { mutableStateOf(newPrefs.getBoolean("worktree", false)) }
    var agents by remember { mutableStateOf(listOf<AgentAvailability>()) }
    var models by remember { mutableStateOf(listOf<Model>()) }
    var starting by remember { mutableStateOf(false) }
    var cloning by remember { mutableStateOf<String?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }

    val machinePick = machine?.takeIf { it in machines } ?: initial
    val botPick: Pair<String, Bot>? = if (mode == "bot") bots.firstOrNull { it.second.id == botId } ?: bots.firstOrNull() else null
    val bot = botPick?.second
    val model = models.firstOrNull { it.id == modelId }
    // A bot's task runs where the page's own checkout is: the PR's branch lives there.
    val at = if (bot != null) (if (botCheckout) initial else null) else machinePick

    fun repairEffort() {
        val m = models.firstOrNull { it.id == modelId } ?: return
        effort = Picks.usableEffort(m, effort)
        if (!Picks.offersFast(harness, m)) fast = false
    }

    fun pickHarness(h: String) {
        harness = h
        modelId = rememberedModel(context, h)
        effort = null
        models = emptyList()
    }

    // The latest task's agent and model, since that agent did the work, else a new task's remembered ones.
    LaunchedEffect(Unit) {
        if (harness.isNotEmpty()) return@LaunchedEffect
        if (latest != null) {
            harness = latest.harness; modelId = latest.model; effort = latest.effort; fast = latest.fast ?: false
        } else {
            harness = newPrefs.getString("harness", null) ?: "claude_code"
            modelId = rememberedModel(context, harness)
            fast = newPrefs.getBoolean("fast", false)
        }
    }
    LaunchedEffect(machinePick?.server, harness) {
        val server = machinePick?.server ?: return@LaunchedEffect
        if (harness.isEmpty()) return@LaunchedEffect
        val asked = harness
        agents = store.agents(server)
        // A machine without this agent starts on one it has.
        if (agents.isNotEmpty() && agents.none { it.harness == asked && it.available }) {
            agents.firstOrNull { it.available }?.let { pickHarness(it.harness) }
            return@LaunchedEffect
        }
        models = runCatching { decodeList<Model>(store.call(server, "list_models", jsonOf("harness" to asked))) }.getOrDefault(emptyList())
        // A remembered model this agent no longer runs would reach the server as a pick nobody made.
        modelId = Picks.usableModel(models, modelId, asked)
        repairEffort()
    }

    /** Attaches or clones the picked checkout first where it needs it, then hands everything to [run]. */
    fun start() {
        if (starting) return
        val server = at?.server ?: botPick?.first ?: return
        focus.clearFocus()
        scope.launch {
            starting = true
            failure = null
            try {
                var cwd = at?.path
                if (at != null && at.kind != PrCheckout.Kind.Here) {
                    val (slug, remote) = clone ?: ("" to "")
                    val before = store.projects[at.server].orEmpty().map { it.path }.toSet()
                    val list = try {
                        if (at.kind == PrCheckout.Kind.Clone) {
                            cloning = slug
                            store.cloneProgress[at.server] = store.cloneProgress[at.server].orEmpty() - slug
                            // A clone runs as long as the repository is big; progress arrives meanwhile.
                            decodeList<Project>(store.call(at.server, "clone_github_repo", jsonOf("slug" to slug), timeoutMs = 1_800_000))
                        } else {
                            decodeList<Project>(store.call(at.server, "add_project", jsonOf("path" to at.path)))
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        failure = if (at.kind == PrCheckout.Kind.Clone) "Could not clone $slug into ~/dray: ${e.message}" else "Could not attach ${at.path}: ${e.message}"
                        return@launch
                    } finally {
                        cloning = null
                    }
                    store.attached(at.server, list)
                    // By full path, never by folder name: two checkouts can share one.
                    val made = if (at.kind == PrCheckout.Kind.Attach) list.firstOrNull { it.path == at.path }
                    else list.firstOrNull { it.path !in before && it.remote == remote } ?: list.firstOrNull { it.remote == remote }
                    if (made == null) { failure = "The checkout was made but is not in the project list."; return@launch }
                    cwd = made.path
                    store.pulls.loadMarks(listOf(ProjectKey(at.server, made.path)), force = true)
                }
                val pick = StartPick(server, cwd, bot, text, harness, modelId, effort, fast && Picks.offersFast(harness, model), worktree)
                run(pick)
                setText("")
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                started(pick)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = e.message ?: "Failed"
            } finally {
                starting = false
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(Dray.Space.m)) {
        note?.invoke()
        if (bots.isNotEmpty()) {
            ChipRow(focus = if (botPick != null) bots.indexOf(botPick) else bots.size) {
                items(bots.size) { i ->
                    val (_, b) = bots[i]
                    BotChip(b, bot?.id == b.id) {
                        mode = "bot"; botId = b.id
                        prefs.edit().putString("$prefsKey.startMode", mode).putString("$prefsKey.startBot", botId).apply()
                    }
                }
                item {
                    PickChip("Task", bot == null) { mode = "task"; prefs.edit().putString("$prefsKey.startMode", mode).apply() }
                }
            }
        }
        if (bot == null) PickCard {
            PickMenu(placeLabel, machinePick?.let { label(store.name(it.server), it) } ?: "None attached",
                machines.map { it to label(store.name(it.server), it) }, machinePick, pick = { machine = it })
            if (worktreeSwitch) {
                PickDivider()
                PickRow("Worktree") { PickSwitch(worktree) { worktree = it } }
            }
            val usable = agents.filter { it.available }
            if (usable.size > 1) {
                PickDivider()
                PickMenu("Agent", Picks.agentLabels[harness] ?: harness, usable.map { it.harness to it.label }, harness, pick = { pickHarness(it) })
            }
            if (models.isNotEmpty()) {
                PickDivider()
                val choices = (if (Picks.defaultModel[harness] == "") listOf("" to "Default") else emptyList()) + models.map { it.id to it.label }
                PickMenu("Model", model?.label ?: modelId.ifEmpty { "Default" }, choices, modelId, pick = { modelId = it; repairEffort() })
            }
            if (model != null && model.efforts.isNotEmpty()) {
                PickDivider()
                PickMenu("Effort", effort?.let { Picks.effortLabels[it] ?: it }.orEmpty(),
                    model.efforts.map { it to (Picks.effortLabels[it] ?: it) }, effort, pick = { effort = it })
            }
            if (Picks.offersFast(harness, model)) {
                PickDivider()
                PickRow("Fast mode") { PickSwitch(fast) { fast = it } }
            }
        }
        Box(Modifier.fillMaxWidth().heightIn(min = 96.dp).clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.raised).padding(14.dp)) {
            if (text.isEmpty()) Text(placeholder, style = Dray.Font.body.copy(color = Dray.tertiary))
            BasicTextField(text, setText, Modifier.fillMaxWidth(), textStyle = Dray.Font.body, cursorBrush = SolidColor(Dray.text), maxLines = 8)
        }
        val enabled = !starting && (at != null || (bot != null && !botCheckout))
        Row(
            Modifier.fillMaxWidth().height(48.dp).clip(CircleShape).background(Dray.primary).alpha(if (enabled) 1f else 0.5f)
                .clickable(enabled = enabled, onClick = ::start),
            horizontalArrangement = Arrangement.spacedBy(Dray.Space.s, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
        ) {
            if (starting) CircularProgressIndicator(Modifier.size(16.dp), color = Dray.onPrimary, strokeWidth = 2.dp)
            Text(
                when { cloning != null -> "Cloning…"; starting -> "Starting…"; bot != null -> "Start in ${bot.name}"; else -> "Start task" },
                style = Dray.Font.headline.copy(color = Dray.onPrimary),
            )
        }
        val line = when {
            cloning != null -> "Cloning $cloning" + (store.cloneProgress[at?.server]?.get(cloning)?.let { " · $it" } ?: "…")
            at?.kind == PrCheckout.Kind.Attach -> "Attaches ${at.path} first, the checkout a task of this repo already uses."
            else -> null
        }
        line?.let { Text(it, Modifier.padding(horizontal = Dray.Space.xs), style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = 1) }
        failure?.let { Text(sentence(it), Modifier.padding(horizontal = Dray.Space.xs), style = Dray.Font.footnote.copy(color = Dray.destructive)) }
    }
}

private fun label(place: String, c: PrCheckout) =
    if (c.kind == PrCheckout.Kind.Clone) "$place · clone into ~/dray" else "$place · ${File(c.path).name}"

/** A bot as a chip in the start box: its face and name, light when picked. */
@Composable
private fun BotChip(bot: Bot, selected: Boolean, pick: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    Row(
        Modifier.height(36.dp).clip(CircleShape).background(if (selected) Dray.text else Dray.tile)
            .clickable { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); pick() }
            .padding(start = 9.dp, end = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        BotFace(bot, 18.dp)
        Text(bot.name, style = (if (selected) Dray.Font.pill else Dray.Font.subhead).copy(color = if (selected) Dray.page else Dray.text), maxLines = 1)
    }
}
