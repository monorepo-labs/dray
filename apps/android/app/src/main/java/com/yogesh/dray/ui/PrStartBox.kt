package com.yogesh.dray.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.AgentAvailability
import com.yogesh.dray.model.Model
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.PrCheckout
import com.yogesh.dray.model.ProjectKey
import com.yogesh.dray.model.PullRequest
import com.yogesh.dray.model.PullRow
import com.yogesh.dray.model.prInitial
import com.yogesh.dray.model.prMachines
import com.yogesh.dray.model.prPrompt
import com.yogesh.dray.model.prRepoSlug
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.store.rememberedModel
import com.yogesh.dray.wire.Bot
import com.yogesh.dray.wire.Project
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.jsonOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID

// PullDetail.swift's `PrStartBox`: a task for the PR, the reader's own or a bot's, on the PR's own branch.

/**
 * The box a task for the PR starts from: a bot's task or the reader's own, the plain task's
 * machine, agent, model, effort and fast mode, the reader's words, and Start. A bot's task runs
 * on the bot's own agent, so the pickers belong to the plain task alone. Always Auto: the page
 * offers no stance. Picked comments are quoted into the prompt.
 */
@Composable
fun PrStartBox(row: PullRow, pr: PullRequest, picked: Set<String>, latest: SessionItem?, started: () -> Unit) {
    val store = LocalStore.current
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val prefs = remember { context.getSharedPreferences("store", Context.MODE_PRIVATE) }
    var mode by remember { mutableStateOf(prefs.getString("pr.startMode", "bot")!!) }
    var botId by remember { mutableStateOf(prefs.getString("pr.startBot", "").orEmpty()) }
    var text by remember(row.id) { mutableStateOf("") }
    var machine by remember { mutableStateOf<PrCheckout?>(null) }
    var harness by remember { mutableStateOf("") }
    var modelId by remember { mutableStateOf("") }
    var effort by remember { mutableStateOf<String?>(null) }
    var fast by remember { mutableStateOf(false) }
    var agents by remember { mutableStateOf(listOf<AgentAvailability>()) }
    var models by remember { mutableStateOf(listOf<Model>()) }
    var starting by remember { mutableStateOf(false) }
    var cloning by remember { mutableStateOf<String?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }

    val connected = store.live.filter { store.serverState[it.id] == ConnState.Connected }.map { it.id }
    val machines = prMachines(row, connected) { store.projects[it].orEmpty() }
    val initial = prInitial(row, machines)
    val machinePick = machine?.takeIf { it in machines } ?: if (machines.isEmpty()) null else initial
    val bots = store.bots[initial.server].orEmpty()
    val bot: Bot? = if (mode == "bot") bots.firstOrNull { it.id == botId } ?: bots.firstOrNull() else null
    val model = models.firstOrNull { it.id == modelId }

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

    // The PR's latest task's agent and model, since that agent did the work, else a new task's remembered ones.
    LaunchedEffect(Unit) {
        if (harness.isNotEmpty()) return@LaunchedEffect
        if (latest != null) {
            harness = latest.harness; modelId = latest.model; effort = latest.effort; fast = latest.fast ?: false
        } else {
            val newPrefs = context.getSharedPreferences("new", Context.MODE_PRIVATE)
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

    /**
     * A new worktree on the PR's own branch, the reader's own task or the bot's; a checkout
     * attached or cloned first only now, so opening a PR changes nothing on disk.
     */
    fun start() {
        val at = (if (bot != null) initial else machinePick) ?: return
        if (starting) return
        focus.clearFocus()
        scope.launch {
            starting = true
            failure = null
            try {
                var cwd = at.path
                if (at.kind != PrCheckout.Kind.Here) {
                    val slug = if (row.key.startsWith("github:")) row.key.removePrefix("github:") else prRepoSlug(row.mark.url).orEmpty()
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
                    else list.firstOrNull { it.path !in before && it.remote == row.repo } ?: list.firstOrNull { it.remote == row.repo }
                    if (made == null) { failure = "The checkout was made but is not in the project list."; return@launch }
                    cwd = made.path
                    store.pulls.loadMarks(listOf(ProjectKey(at.server, made.path)), force = true)
                }
                val item = decodeOrNull<SessionItem>(store.call(at.server, "start_pr_session", jsonOf(
                    "sessionId" to UUID.randomUUID().toString().lowercase(),
                    "prompt" to prPrompt(pr, picked, text),
                    "harness" to harness, "model" to modelId, "effort" to effort,
                    "permissionMode" to "auto", "fast" to fast, "cwd" to cwd,
                    "prHead" to mapOf("branch" to row.mark.headRefName, "repo" to row.repo),
                    "prNumber" to row.mark.number, "bot" to bot?.id,
                ), timeoutMs = 120_000))
                item?.let { store.created(at.server, it) }
                text = ""
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                started()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val said = e.message ?: "Failed"
                // Asked before anything is made, so nothing is left to tidy up.
                failure = if (said.contains("unknown command")) "This server is older than the pull requests page. Update it, then start the task again." else said
            } finally {
                starting = false
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(Dray.Space.m)) {
        Text("Start a task", Modifier.padding(horizontal = Dray.Space.xs), style = Dray.Font.footnote.copy(color = Dray.tertiary))
        if (row.listing.isCrossRepository) {
            Text("Read only. This branch lives in a fork, so an agent here can't push to it.", style = Dray.Font.subhead.copy(color = Dray.secondary))
        } else {
            Row(Modifier.padding(horizontal = Dray.Space.xs), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.AutoMirrored.Filled.CallSplit, null, Modifier.size(14.dp), tint = Dray.secondary)
                Text(buildAnnotatedString {
                    append("New worktree on ")
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = Dray.text)) { append(row.mark.headRefName) }
                    append(", the PR's own branch")
                }, style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = 2)
            }
            if (bots.isNotEmpty()) {
                Box(Modifier.padding(horizontal = Dray.Space.l)) {
                    ChipRow(focus = if (bot != null) bots.indexOf(bot) else bots.size) {
                        items(bots.size) { i ->
                            val b = bots[i]
                            BotChip(b, bot?.id == b.id) {
                                mode = "bot"; botId = b.id
                                prefs.edit().putString("pr.startMode", mode).putString("pr.startBot", botId).apply()
                            }
                        }
                        item {
                            PickChip("Task", bot == null) { mode = "task"; prefs.edit().putString("pr.startMode", mode).apply() }
                        }
                    }
                }
            }
            if (bot == null) PickCard {
                PickMenu("Machine", machinePick?.let { label(store.name(it.server), it) }.orEmpty(),
                    machines.map { it to label(store.name(it.server), it) }, machinePick, pick = { machine = it })
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
            Box(Modifier.fillMaxWidth().heightIn(min = 72.dp).clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.raised).padding(14.dp)) {
                if (text.isEmpty()) Text("What should the agent do with this pull request?", style = Dray.Font.body.copy(color = Dray.tertiary))
                BasicTextField(text, { text = it }, Modifier.fillMaxWidth(), textStyle = Dray.Font.body, cursorBrush = SolidColor(Dray.text), maxLines = 8)
            }
            val enabled = !starting && (bot != null || machinePick != null)
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
            val note = when {
                cloning != null -> "Cloning $cloning" + (store.cloneProgress[(if (bot != null) initial else machinePick)?.server]?.get(cloning)?.let { " · $it" } ?: "…")
                ((if (bot != null) initial else machinePick)?.kind) == PrCheckout.Kind.Attach -> "Attaches ${row.key} first, the checkout a task of this repo already uses."
                else -> null
            }
            note?.let { Text(it, Modifier.padding(horizontal = Dray.Space.xs), style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = 1) }
            if (picked.isNotEmpty()) {
                Text(if (picked.size == 1) "Quotes the comment picked above." else "Quotes the ${picked.size} comments picked above.",
                    Modifier.padding(horizontal = Dray.Space.xs), style = Dray.Font.footnote.copy(color = Dray.tertiary))
            }
        }
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
