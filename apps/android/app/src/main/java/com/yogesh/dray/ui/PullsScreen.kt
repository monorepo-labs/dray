package com.yogesh.dray.ui

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.InboxSection
import com.yogesh.dray.model.PeopleFilter
import com.yogesh.dray.model.ProjectKey
import com.yogesh.dray.model.PullRow
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.inboxSection
import com.yogesh.dray.model.matches
import com.yogesh.dray.model.sessionsForPr
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.store.PullsModel
import com.yogesh.dray.store.Store
import com.yogesh.dray.store.botOf
import com.yogesh.dray.store.repoOf
import com.yogesh.dray.store.trackerServer
import com.yogesh.dray.wire.parseDate
import com.yogesh.dray.wire.shortAge
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Pulls.swift's page: every open pull request in the projects on screen, filed by what it wants from the reader.

/** The page's picks, kept on the phone: a relaunch opens the page as it was left. */
private class PullsPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("store", Context.MODE_PRIVATE)
    var people by mutableStateOf(PeopleFilter.entries.firstOrNull { it.name == prefs.getString("pulls.people", null) } ?: PeopleFilter.Involving)
    /** A space's name, or empty for every one. */
    var space by mutableStateOf(prefs.getString("pulls.space", "").orEmpty())
    var owner by mutableStateOf(prefs.getString("pulls.owner", null))
    var repo by mutableStateOf(prefs.getString("pulls.repo", null))

    fun save() = prefs.edit().putString("pulls.people", people.name).putString("pulls.space", space)
        .putString("pulls.owner", owner).putString("pulls.repo", repo).apply()
}

/**
 * The desktop's pull requests page on a phone. People filters lead, the search box under them
 * narrows by title, number, author or branch; space, owner and repository sit behind the filter
 * button, which fills while any narrows the list. Draws the last read at once, from disk on a
 * fresh launch, and reads behind it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PullsScreen(back: () -> Unit, open: (PullRow) -> Unit) {
    val store = LocalStore.current
    val model = store.pulls
    val context = LocalContext.current
    val picks = remember { PullsPrefs(context) }
    var query by rememberSaveable { mutableStateOf("") }
    var searching by rememberSaveable { mutableStateOf(false) }
    var filtering by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val connected = store.live.filter { store.serverState[it.id] == ConnState.Connected }.map { it.id }
    val keys = pullsKeys(store, picks.space)
    // Before any server is up, the last search's server stands in, so its answer draws.
    val home = store.trackerServer ?: model.home
    val rows = allRows(store, model, picks.people, picks.owner, picks.space, keys, home)
    val repos = rows.map { it.repoName }.distinct().sorted()
    val repoShown = picks.repo?.takeIf { it in repos }
    val narrowed = rows.filter { r ->
        (picks.owner == null || r.owner.equals(picks.owner, ignoreCase = true)) && (repoShown == null || r.repoName == repoShown)
    }
    val shown = narrowed.filter { it.matches(query) }
    val sections = InboxSection.entries.mapNotNull { s -> shown.filter { inboxSection(it.mark) == s }.takeIf { it.isNotEmpty() }?.let { s to it } }
    val search = picks.people.search

    suspend fun read(force: Boolean) {
        if (search != null) model.search(search, picks.owner, force)
        else model.loadMarks(keys.filter { it.server in connected }, force)
    }
    // Again on every pick and server change, then every minute while the page is up.
    val readKey = "${picks.people}|${picks.owner}|${picks.space}|${connected.joinToString()}|${keys.size}"
    LaunchedEffect(readKey) {
        if (connected.isEmpty()) return@LaunchedEffect
        read(force = false)
        while (true) {
            delay(60_000)
            read(force = true)
        }
    }
    // Settled tasks are part of a PR's history.
    LaunchedEffect(connected.size) { if (connected.isNotEmpty()) store.loadSettled() }

    val loaded = if (search != null) model.searched(home, search, picks.owner) || model.searchError != null
    else keys.any { model.marks[it] != null || model.markErrors[it] != null }
    val missing = if (search != null) model.searchError?.takeIf { it.keepsButton }
    else keys.firstNotNullOfOrNull { model.markErrors[it]?.takeIf { e -> e.keepsButton } }
    val errors = if (search != null) listOfNotNull(model.searchError?.takeIf { it.kind == "other" }?.let { "GitHub search: ${it.sentence}" })
    else keys.mapNotNull { k -> model.markErrors[k]?.takeIf { it.kind == "other" }?.let { "${k.path.substringAfterLast('/')}: ${it.sentence}" } }

    Column(Modifier.fillMaxSize().background(Dray.page).statusBarsPadding().navigationBarsPadding()) {
        Bar("Pull requests", back) {
            if (model.loading > 0 && rows.isNotEmpty()) {
                CircularProgressIndicator(Modifier.padding(end = 8.dp).size(16.dp), color = Dray.tertiary, strokeWidth = 2.dp)
            }
            SearchButton(searching) { searching = true }
            val any = picks.space.isNotEmpty() || picks.owner != null || repoShown != null
            IconButton({ filtering = true }) {
                Icon(if (any) Icons.Filled.FilterList else Icons.Outlined.FilterList, "Filters", tint = if (any) Dray.text else Dray.secondary)
            }
        }
        if (searching) SearchField(query, "Search title, number, author, branch", close = { query = ""; searching = false }) { query = it }
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { refreshing = true; scope.launch { read(force = true); refreshing = false } },
            modifier = Modifier.weight(1f),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 40.dp)) {
                item("people") {
                    Box(Modifier.padding(horizontal = Dray.Space.l, vertical = Dray.Space.s)) {
                        ChipRow(focus = PeopleFilter.entries.indexOf(picks.people)) {
                            items(PeopleFilter.entries.size) { i ->
                                val f = PeopleFilter.entries[i]
                                PickChip(f.label, picks.people == f) { picks.people = f; picks.save() }
                            }
                        }
                    }
                }
                for ((i, line) in errors.withIndex()) item("error-$i") {
                    Text(inlineMarkdown(line), Modifier.padding(horizontal = 20.dp, vertical = 4.dp), style = Dray.Font.footnote.copy(color = Dray.destructive))
                }
                when {
                    missing != null && rows.isEmpty() -> item("missing") { Note(missing.sentence) }
                    search == null && keys.isEmpty() -> item("none") { Note("Attach a project with a GitHub remote to see its pull requests.") }
                    !loaded && rows.isEmpty() -> item("reading") { Reading() }
                    sections.isEmpty() && !(rows.isEmpty() && errors.isNotEmpty()) -> item("empty") {
                        Note(when {
                            rows.isEmpty() -> "No open pull requests${picks.people.empty}${if (picks.space.isEmpty()) "" else " in ${picks.space}"}."
                            narrowed.isEmpty() -> "No pull request matches these filters."
                            else -> "No pull request matches “${query.trim()}”."
                        })
                    }
                }
                for ((section, list) in sections) {
                    item("h-$section") {
                        Row(Modifier.padding(start = 20.dp, top = Dray.Space.l, bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(section.label, style = Dray.Font.footnote.copy(color = Dray.tertiary))
                            Text("${list.size}", style = Dray.Font.footnote.copy(color = Dray.dim))
                        }
                    }
                    for (row in list) item(row.id) {
                        PullRowView(row, tasks(store, row).firstOrNull(), showRepo = repoShown == null && repos.size > 1) { open(row) }
                    }
                }
            }
        }
    }

    if (filtering) {
        ModalBottomSheet({ filtering = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Dray.card) {
            PickSheet("Filters", done = { filtering = false }) {
                val spaces = store.live.flatMap { store.projects[it.id].orEmpty() }.mapNotNull { it.space }.distinct().sorted()
                val owners = (model.owners + rows.map { it.owner }).distinctBy { it.lowercase() }
                PickCard {
                    if (spaces.isNotEmpty() || picks.space.isNotEmpty()) {
                        PickMenu("Space", picks.space.ifEmpty { "All spaces" }, listOf("" to "All spaces") + spaces.map { it to it }, picks.space, pick = {
                            picks.space = it; picks.save()
                        })
                        PickDivider()
                    }
                    PickMenu("Owner", picks.owner ?: "All owners", listOf<Pair<String?, String>>(null to "All owners") + owners.map { it to it }, picks.owner, pick = {
                        picks.owner = it; picks.save()
                    })
                    PickDivider()
                    PickMenu("Repository", repoShown ?: "All repositories", listOf<Pair<String?, String>>(null to "All repositories") + repos.map { it to it }, repoShown, pick = {
                        picks.repo = it; picks.save()
                    })
                }
            }
        }
    }
}

/** The spaces' projects on every server, then every bot task's repo, which no space holds: the desktop's `pullsKeys`. */
private fun pullsKeys(store: Store, space: String): List<ProjectKey> {
    val servers = store.live.map { it.id }.toSet()
    val own = store.live.flatMap { s ->
        store.projects[s.id].orEmpty().filter { space.isEmpty() || it.space == space }.map { ProjectKey(s.id, it.path) }
    }
    val bots = store.items.filter { it.value.hidden == true && it.value.archived != true && it.key.server in servers }
        .map { ProjectKey(it.key.server, it.value.projectPath) }
    return (own + bots).distinct()
}

private fun allRows(
    store: Store, model: PullsModel, people: PeopleFilter, owner: String?, space: String, keys: List<ProjectKey>, home: String?,
): List<PullRow> {
    val filter = people.search ?: return model.markRows(keys)
    home ?: return emptyList()
    val rows = model.searchRows(filter, owner, home)
    if (space.isEmpty()) return rows
    // The repos a space holds, as the search spells them: its projects' remotes, and bot tasks' repos.
    val spaceRepos = (keys.mapNotNull { store.repoOf(it.server, it.path) } + model.checkouts.filter { it.value in keys }.keys).toSet()
    return rows.filter { it.repo in spaceRepos }
}

fun tasks(store: Store, row: PullRow): List<SessionKey> =
    sessionsForPr(row, store.items, { s, p -> store.repoOf(s, p) }) { store.serverState[it] == ConnState.Connected }

/**
 * A list page's search box, opened from its bar's search button: focused with the keyboard up as
 * it appears. Close clears the words and hides it again.
 */
@Composable
fun SearchField(value: String, hint: String, close: () -> Unit, change: (String) -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    BackHandler(onBack = close)
    Row(
        Modifier.padding(horizontal = Dray.Space.l, vertical = Dray.Space.xs).fillMaxWidth().height(40.dp)
            .clip(RoundedCornerShape(Dray.Radius.md)).background(Dray.raised).padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Search, null, Modifier.size(18.dp), tint = Dray.tertiary)
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) Text(hint, style = Dray.Font.subhead.copy(color = Dray.tertiary), maxLines = 1, overflow = TextOverflow.Ellipsis)
            BasicTextField(
                value, change, Modifier.fillMaxWidth().focusRequester(focus), singleLine = true,
                textStyle = Dray.Font.subhead, cursorBrush = SolidColor(Dray.text),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            )
        }
        Icon(Icons.Filled.Close, "Close search", Modifier.size(32.dp).clip(CircleShape).clickable(onClick = close).padding(7.dp), tint = Dray.secondary)
    }
}

/** The bar's search button: lit while the box is open or holds words. */
@Composable
fun SearchButton(on: Boolean, open: () -> Unit) {
    IconButton(open) { Icon(Icons.Outlined.Search, "Search", tint = if (on) Dray.text else Dray.secondary) }
}

@Composable
fun Note(line: String) {
    Text(inlineMarkdown(line), Modifier.padding(horizontal = 20.dp, vertical = Dray.Space.m), style = Dray.Font.subhead.copy(color = Dray.tertiary))
}

@Composable
fun Reading(line: String = "Reading…") {
    Row(Modifier.padding(horizontal = 20.dp).height(44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dray.Space.s)) {
        Orb(OrbKind.Working)
        Text(line, Modifier.shimmer(), style = Dray.Font.subhead.copy(color = Dray.secondary))
    }
}

/** One pull request: its glyph, its title over who and where, and its latest task. */
@Composable
private fun PullRowView(row: PullRow, task: SessionKey?, showRepo: Boolean, onClick: () -> Unit) {
    val store = LocalStore.current
    val l = row.listing
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onClick).padding(start = 20.dp, end = 16.dp, top = 10.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.padding(top = 3.dp)) { PrGlyph(row.mark, 16.dp) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(l.title, style = Dray.Font.body.copy(color = Dray.text.copy(alpha = 0.88f)), maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                val foot = Dray.Font.footnote.copy(color = Dray.tertiary)
                Text("#${row.mark.number}", style = foot, maxLines = 1)
                if (showRepo) Text(row.repoName.substringAfterLast('/'), style = foot, maxLines = 1)
                // Its latest task; a bot's wears its face. A PR with none says nothing.
                val item = task?.let { store.items[it] }
                if (item != null) {
                    val bot = store.botOf(task)
                    Text("·", style = foot)
                    bot?.let { BotFace(it, 13.dp) }
                    Text(
                        bot?.let { "${it.name} · ${item.title}" } ?: item.title, Modifier.weight(1f, fill = false),
                        style = foot.copy(color = if (item.archived == true) Dray.tertiary else Dray.secondary), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                } else if (l.isCrossRepository) {
                    Text("· Read only", style = foot.copy(color = Dray.dim), maxLines = 1)
                }
            }
        }
        // Who opened it sits under when it last moved, at the row's edge.
        Column(Modifier.padding(top = 3.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            if (row.mark.checksState == "RUNNING") ChecksSpinner(15.dp)
            else parseDate(l.updatedAt)?.let { Text(shortAge(it), style = Dray.Font.footnote.copy(color = Dray.tertiary)) }
            Avatar(l.authorAvatar, 18, l.author)
        }
    }
}
