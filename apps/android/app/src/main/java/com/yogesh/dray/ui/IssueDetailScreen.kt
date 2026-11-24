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
import androidx.compose.material.icons.automirrored.filled.CallMade
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.Issue
import com.yogesh.dray.model.IssueComment
import com.yogesh.dray.model.IssueDetail
import com.yogesh.dray.model.IssuePerson
import com.yogesh.dray.model.IssueUnavailable
import com.yogesh.dray.model.Shot
import com.yogesh.dray.model.issueTag
import com.yogesh.dray.model.priorities
import com.yogesh.dray.model.priorityLabels
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.wire.ImageRef
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.parseDate
import com.yogesh.dray.wire.shortAge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * An opened issue: its status and priority, which move from here, its people and labels, its
 * description and conversation, and Work on it, which carries its tag to the new-task dock.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun IssueDetailScreen(server: String, id: String, identifier: String, back: () -> Unit, workOn: (String) -> Unit) {
    val store = LocalStore.current
    val model = store.issues
    val uri = LocalUriHandler.current
    val scope = rememberCoroutineScope()
    val detail = model.details[id]
    val shown = detail?.issue ?: model.issue(id)
    var failure by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var gallery by remember { mutableStateOf<ImageRef?>(null) }
    val connected = store.serverState[server] == ConnState.Connected

    suspend fun read() {
        try {
            val read = IssueDetail.decode(store.call(server, "get_issue", jsonOf("identifier" to identifier, "id" to id)))
                ?: throw IllegalStateException("The issue could not be read.")
            model.details[id] = read
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
                shown?.url?.takeIf { it.isNotEmpty() }?.let { url ->
                    IconButton({ runCatching { uri.openUri(url) } }) {
                        Icon(Icons.AutoMirrored.Filled.CallMade, "Open in the tracker", Modifier.size(20.dp), tint = Dray.text)
                    }
                }
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
                    item("work") {
                        CapsuleButton("Work on it", light = true) { workOn(issueTag(shown.identifier, shown.title)) }
                    }
                }
            }
        }
    }
    gallery?.let { ref -> ImageViewer(listOf(Shot(ref, "Image", ref.url)), 0) { gallery = null } }
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
