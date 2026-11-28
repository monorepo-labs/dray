package com.yogesh.dray.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.Issue
import com.yogesh.dray.model.IssueComment
import com.yogesh.dray.model.IssueDetail
import com.yogesh.dray.model.IssuePerson
import com.yogesh.dray.model.IssueUnavailable
import com.yogesh.dray.model.Shot
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.issueInitial
import com.yogesh.dray.model.issueMachines
import com.yogesh.dray.model.issuePrompt
import com.yogesh.dray.model.issueRepo
import com.yogesh.dray.model.priorities
import com.yogesh.dray.model.priorityLabels
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.store.Store
import com.yogesh.dray.store.botChat
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.sentFrom
import com.yogesh.dray.wire.ImageRef
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.parseDate
import com.yogesh.dray.wire.shortAge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * An opened issue: its status and priority, which move from here, its people and labels, its
 * description and conversation, the tasks it has had, and Play, which starts one right here.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun IssueDetailScreen(server: String, id: String, identifier: String, back: () -> Unit, openSession: (SessionKey) -> Unit) {
    val store = LocalStore.current
    val model = store.issues
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val detail = model.details[id]
    val shown = detail?.issue ?: model.issue(id)
    var failure by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var gallery by remember { mutableStateOf<ImageRef?>(null) }
    var starting by remember { mutableStateOf(false) }
    var text by rememberSaveable(id) { mutableStateOf("") }
    val tasks = shown?.let { i -> issueTasks(store, i.identifier) }.orEmpty()
    val connected = store.serverState[server] == ConnState.Connected

    suspend fun read() {
        try {
            val read = IssueDetail.decode(store.call(server, "get_issue", jsonOf("identifier" to identifier, "id" to id)))
                ?: throw IllegalStateException("The issue could not be read.")
            model.details[id] = read
            model.refreshed(read.issue)
            failure = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = IssueUnavailable.from(e).sentence(shown?.tracker ?: "github")
        }
    }

    fun update(stateId: String?, priority: String?) {
        val i = model.details[id]?.issue ?: shown ?: return
        scope.launch {
            saving = true
            try {
                val next = IssueDetail.decode(store.call(server, "update_issue", jsonOf(
                    "identifier" to i.identifier, "id" to i.id, "stateId" to stateId, "priority" to priority,
                ))) ?: throw IllegalStateException("The server's answer could not be read.")
                model.details[id] = next
                model.edited(next.issue)
                failure = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = "Could not update ${i.identifier}: ${e.message ?: "failed"}"
            } finally {
                saving = false
            }
        }
    }
    LaunchedEffect(id, connected) { if (connected) read() }

    CompositionLocalProvider(LocalOpenImage provides { ref: ImageRef -> gallery = ref }) {
        Column(Modifier.fillMaxSize().background(Dray.page).statusBarsPadding().navigationBarsPadding()) {
            Bar(shown?.short ?: identifier, back) {
                val share = shown?.takeIf { it.url.isNotEmpty() }?.let { i -> { shareLink(context, "${i.identifier} ${i.title}".trim(), i.url) } }
                StartActions(share) { starting = true }
            }
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = { refreshing = true; scope.launch { read(); refreshing = false } },
                modifier = Modifier.weight(1f),
            ) {
                LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = Dray.Space.xxl),
                    verticalArrangement = Arrangement.spacedBy(Dray.Space.xl),
                ) {
                    if (shown == null) {
                        item("reading") {
                            if (failure != null) Text(sentence(failure!!), style = Dray.Font.footnote.copy(color = Dray.destructive))
                            else Reading("Reading the issue…")
                        }
                        return@LazyColumn
                    }
                    item("title") {
                        Column(verticalArrangement = Arrangement.spacedBy(Dray.Space.s)) {
                            Text(shown.title, style = Dray.Font.title)
                            Row(horizontalArrangement = Arrangement.spacedBy(Dray.Space.s), verticalAlignment = Alignment.CenterVertically) {
                                StatusMenu(shown, detail) { update(it, null) }
                                if (shown.tracker == "linear") PriorityMenu(shown) { update(null, it) }
                                if (saving) CircularProgressIndicator(Modifier.size(16.dp), color = Dray.tertiary, strokeWidth = 2.dp)
                            }
                        }
                    }
                    item("meta") {
                        Column(verticalArrangement = Arrangement.spacedBy(Dray.Space.s)) {
                            shown.author?.let { Person(it, "${it.name} opened this") }
                            shown.assignee?.let { Person(it, "Assigned to ${it.name}") }
                            val facts = listOfNotNull(
                                shown.issueType?.name, shown.project,
                                shown.pullRequests.takeIf { it.isNotEmpty() }?.joinToString(", ") { "#$it" }?.let { "PR $it" },
                                parseDate(shown.updatedAt)?.let { "Updated ${shortAge(it)} ago" },
                            )
                            if (facts.isNotEmpty()) Text(facts.joinToString(" · "), style = Dray.Font.footnote.copy(color = Dray.tertiary))
                            if (shown.labels.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                for (l in shown.labels) LabelChip(l.name, l.color)
                            }
                        }
                    }
                    if (tasks.isNotEmpty()) item("tasks") { TaskList(tasks, openSession) }
                    failure?.let { f -> item("failure") { Text(sentence(f), style = Dray.Font.footnote.copy(color = Dray.destructive)) } }
                    if (detail != null) {
                        item("description") {
                            val text = detail.description?.takeIf { it.isNotBlank() }
                            if (text != null) Box(Modifier.prGroup()) { MarkdownText(remember(text) { com.yogesh.dray.model.prBodyMarkdown(text) }, style = Dray.Font.subhead) }
                            else Text("No description.", style = Dray.Font.subhead.copy(color = Dray.tertiary))
                        }
                        if (detail.comments.isNotEmpty()) item("comments") {
                            Column(verticalArrangement = Arrangement.spacedBy(Dray.Space.s)) {
                                Text("Comments", Modifier.padding(horizontal = Dray.Space.xs), style = Dray.Font.footnote.copy(color = Dray.tertiary))
                                for (c in detail.comments) Comment(c)
                            }
                        }
                    } else if (failure == null) item("reading") { Reading("Reading the issue…") }
                }
            }
        }
    }
    if (starting) StartSheet("Start a task", { starting = false }) {
        if (shown == null) Reading("Reading the issue…")
        else IssueStartBox(server, shown, detail?.description, text, { text = it }, tasks.firstOrNull()?.let { store.items[it] }) { pick ->
            starting = false
            // A bot takes the issue in its chat, where its answer and the task it starts land.
            pick.bot?.let { b -> store.botChat(pick.server, b).lastOrNull()?.let(openSession) }
        }
    }
    gallery?.let { ref -> ImageViewer(listOf(Shot(ref, "Image", ref.url)), 0) { gallery = null } }
}

/** Tasks started on or tagged with the issue, newest first; a bot's own chat it was sent to is not one. */
private fun issueTasks(store: Store, identifier: String): List<SessionKey> =
    store.items.filter { (k, v) -> v.issues.any { it.identifier == identifier } && store.bot(k) == null }
        .entries.sortedByDescending { it.value.created ?: it.value.modified }.map { it.key }

/**
 * A task for the issue, started in place: the reader's own in a checkout of its repo (a clone
 * where a machine has none) or any project for Linear, on its tag, link and body with the note
 * last; or a bot's, sent the issue to start once free. The desktop's `startIssueTask` and `sendIssueToBot`.
 */
@Composable
private fun IssueStartBox(
    server: String, issue: Issue, body: String?, text: String, setText: (String) -> Unit, latest: SessionItem?, started: (StartPick) -> Unit,
) {
    val store = LocalStore.current
    val connected = store.live.filter { store.serverState[it.id] == ConnState.Connected }.map { it.id }
    val machines = issueMachines(issue, connected) { store.projects[it].orEmpty() }
    val repo = issueRepo(issue)
    StartBox(
        prefsKey = "issue", text = text, setText = setText,
        placeholder = "Anything to add for the agent?",
        placeLabel = if (repo != null) "Machine" else "Project",
        machines = machines, initial = issueInitial(server, machines),
        clone = repo?.let { it to "github.com/$it".lowercase() },
        bots = connected.flatMap { s -> store.bots[s].orEmpty().map { s to it } },
        botCheckout = false,
        latest = latest,
        worktreeSwitch = true,
        note = {
            Text("The agent gets ${issue.short}'s title, link and description, then your words.",
                Modifier.padding(horizontal = Dray.Space.xs), style = Dray.Font.footnote.copy(color = Dray.secondary))
        },
        run = { p ->
            val bot = p.bot
            if (bot != null) {
                try {
                    store.call(p.server, "send_issue_to_bot", jsonOf(
                        "botId" to bot.id,
                        "issue" to mapOf("tracker" to issue.tracker, "id" to issue.id, "identifier" to issue.identifier, "title" to issue.title, "url" to issue.url),
                        "note" to p.text.trim().ifEmpty { null },
                    ))
                } catch (e: Exception) {
                    if (e.message?.contains("unknown command") == true) throw IllegalStateException("Update ${store.name(p.server)} to send ${bot.name} issues.")
                    throw e
                }
            } else {
                val reply = store.call(p.server, "send_msg", jsonOf(
                    "sessionId" to UUID.randomUUID().toString().lowercase(),
                    "prompt" to issuePrompt(issue, body, p.text),
                    "attachmentPaths" to emptyList<String>(),
                    "harness" to p.harness, "model" to p.model, "effort" to p.effort,
                    "permissionMode" to Picks.stanceFor(p.harness, "auto"),
                    "fast" to p.fast, "cwd" to p.cwd, "branch" to null,
                    "useWorktree" to p.worktree, "worktreeName" to null, "baseRef" to null,
                    "isNewSession" to true,
                    "issueIds" to listOf(issue.identifier),
                    *sentFrom(),
                ))
                decodeOrNull<SessionItem>(reply["snapshot"])?.let { store.created(p.server, it) }
            }
        },
        started = started,
    )
}

@Composable
private fun Person(p: IssuePerson, line: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dray.Space.s)) {
        Avatar(p.avatar, 18, p.name)
        Text(line, style = Dray.Font.subhead.copy(color = Dray.secondary))
    }
}

@Composable
private fun Comment(c: IssueComment) {
    Column(Modifier.prGroup(14.dp), verticalArrangement = Arrangement.spacedBy(Dray.Space.s)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dray.Space.s)) {
            Avatar(c.author.avatar, 20, c.author.name)
            Text(c.author.name, Modifier.weight(1f), style = Dray.Font.subhead, maxLines = 1, overflow = TextOverflow.Ellipsis)
            parseDate(c.createdAt)?.let { Text(shortAge(it), style = Dray.Font.subhead.copy(color = Dray.tertiary)) }
        }
        MarkdownText(remember(c.body) { com.yogesh.dray.model.prBodyMarkdown(c.body) }, style = Dray.Font.subhead)
    }
}

/** A capsule that opens a menu of choices, a check by the current one. */
@Composable
private fun <T> MenuCapsule(label: @Composable () -> Unit, choices: List<Pair<T, String>>, current: T?, pick: ((T) -> Unit)?) {
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.height(32.dp).clip(CircleShape).background(Dray.raised)
                .then(if (pick != null) Modifier.clickable { open = true } else Modifier).padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            label()
            if (pick != null) Icon(Icons.Filled.UnfoldMore, null, Modifier.size(14.dp), tint = Dray.tertiary)
        }
        if (pick != null) DropdownMenu(open, { open = false }, containerColor = Dray.tile) {
            for ((v, text) in choices) DropdownMenuItem(
                { Text(text, style = Dray.Font.body) },
                { open = false; if (v != current) pick(v) },
                leadingIcon = { Box(Modifier.size(18.dp)) { if (v == current) Icon(Icons.Filled.Check, null, Modifier.size(18.dp), tint = Dray.text) } },
            )
        }
    }
}

/** The workflow of the issue's own team; a plain mark until the read lands. */
@Composable
private fun StatusMenu(i: Issue, detail: IssueDetail?, pick: (String) -> Unit) {
    val states = detail?.states.orEmpty()
    MenuCapsule(
        label = {
            IssueStateGlyph(i.state.kind, i.state.color)
            Text(i.state.name, style = Dray.Font.subhead)
        },
        choices = states.map { it.id to it.name }, current = i.state.id, pick = if (states.isEmpty()) null else pick,
    )
}

@Composable
private fun PriorityMenu(i: Issue, pick: (String) -> Unit) {
    MenuCapsule(
        label = {
            PriorityGlyph(i.priority)
            Text(priorityLabels[i.priority] ?: i.priority, style = Dray.Font.subhead)
        },
        choices = priorities.map { it to (priorityLabels[it] ?: it) }, current = i.priority, pick = pick,
    )
}
