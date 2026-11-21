package com.yogesh.dray.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxWidth as fill
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.TurnPrompt
import com.yogesh.dray.model.buildTurns
import com.yogesh.dray.model.plural
import com.yogesh.dray.wire.ImageRef
import kotlinx.coroutines.delay

/** One task's transcript, live, with the reply dock at its foot. */
@Composable
fun TranscriptScreen(key: SessionKey, back: () -> Unit, openSettings: (String) -> Unit) {
    val store = LocalStore.current
    val item = store.items[key]
    val transcript = store.transcripts[key]
    val busy = item?.busy == true
    val turns = remember(transcript, busy) { transcript?.let { buildTurns(it.events, busy) }.orEmpty() }
    val asks = store.asks[key].orEmpty()
    val queued = store.queued[key].orEmpty()
    val tasks = store.tasks[key].orEmpty()
    var gallery by remember { mutableStateOf<Pair<List<com.yogesh.dray.model.Shot>, Int>?>(null) }
    // The runs sheet, on the run a subagent row opened it on; a subagent's own chat over the transcript.
    var runs by remember { mutableStateOf<String?>(null) }
    var showingRuns by remember { mutableStateOf(false) }
    var subagent by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(key) { store.open(key) }

    val list = rememberLazyListState()
    // Pinned while within 40dp of the end; only the reader's own scroll moves it.
    var follow by remember { mutableStateOf(true) }
    val slack = with(LocalDensity.current) { 40.dp.toPx() }
    LaunchedEffect(list) {
        snapshotFlow { Triple(list.isScrollInProgress, list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset) }.collect { (scrolling, i, off) ->
            if (scrolling) follow = i == 0 && off < slack
        }
    }
    val newest = listOf(turns.lastOrNull()?.id, turns.lastOrNull()?.work?.lastOrNull()?.newestId, turns.lastOrNull()?.completed, asks.size, busy, queued.size, tasks.size)
    LaunchedEffect(newest) { if (follow) list.scrollToItem(0) }
    LaunchedEffect(store.sends[key]) {
        follow = true
        list.scrollToItem(0)
    }
    // An open sometimes settles before its last rows measure; once more after they have.
    LaunchedEffect(key) {
        delay(500); if (follow) list.scrollToItem(0)
        delay(500); if (follow) list.scrollToItem(0)
    }

    CompositionLocalProvider(
        LocalImageServer provides key.server,
        LocalCallSession provides key,
        LocalOpenRun provides { id: String ->
            val run = store.runsOf(key).firstOrNull { it.id == id }
            when {
                run == null -> false
                run.chat && !run.locked -> { subagent = id; true }
                else -> { runs = id; showingRuns = true; true }
            }
        },
        LocalOpenImage provides { ref: ImageRef ->
            val shots = shotsOf(turns, ref) ?: listOf(com.yogesh.dray.model.Shot(ref, "Image", ref.path ?: ref.url))
            gallery = shots to shots.indexOfFirst { it.ref == ref }.coerceAtLeast(0)
        },
    ) {
        Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().background(Dray.page).statusBarsPadding().navigationBarsPadding().imePadding()) {
            TitleBar(key, back)
            Box(Modifier.weight(1f)) {
                SelectionContainer {
                    LazyColumn(
                        Modifier.fillMaxSize(),
                        state = list,
                        reverseLayout = true,
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(28.dp, Alignment.Bottom),
                    ) {
                        // Built bottom up: the list is reversed, so it rests on its newest row.
                        asks.forEach { ask -> item("ask-${ask.id}") { MaxWidth { AskCard(key, ask) } } }
                        item("status") {
                            MaxWidth {
                                when {
                                    busy -> WorkingLine()
                                    tasks.isNotEmpty() -> OrbLine(OrbKind.Background, "${plural(tasks.size, "background task")} running",
                                        Modifier.clickable { runs = null; showingRuns = true })
                                }
                            }
                        }
                        if (transcript != null) store.transcriptErrors[key]?.let { err ->
                            item("refresh-error") { MaxWidth { RefreshError(err) { store.retryLoad(key) } } }
                        }
                        queued.reversed().forEach { q -> item("queued-${q.id}") { MaxWidth { UserBubble(TurnPrompt(q.text, null, emptyList()), queued = true) } } }
                        turns.reversed().forEach { t -> item(t.id) { MaxWidth { TurnView(t) } } }
                        placeholder(key, transcript == null, turns.isEmpty() && !busy && queued.isEmpty())
                        if (transcript?.olderBefore != null) item("older") { MaxWidth { Older(key) } }
                    }
                }
                Box(Modifier.align(Alignment.TopCenter)) { SessionBanner(key.server) { openSettings(key.server) } }
            }
            ReplyDock(key)
        }
        subagent?.let { SubagentChat(key, it) { subagent = null } }
        gallery?.let { (shots, at) -> ImageViewer(shots, at) { gallery = null } }
        if (showingRuns) RunsSheet(key, runs, openChat = { showingRuns = false; subagent = it }) { showingRuns = false }
        }
    }
}

private fun LazyListScope.placeholder(key: SessionKey, nothingHeld: Boolean, empty: Boolean) {
    item("placeholder") {
        val store = LocalStore.current
        val err = store.transcriptErrors[key]
        when {
            nothingHeld && err != null -> Column(Modifier.fill().heightIn(min = 420.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text("Couldn't load this session", style = Dray.Font.title)
                Text(sentence(err), Modifier.padding(top = 8.dp), style = Dray.Font.subhead.copy(color = Dray.secondary))
                Text("Try again", Modifier.padding(top = 16.dp).clip(RoundedCornerShape(Dray.Radius.md)).background(Dray.raised)
                    .clickable { store.retryLoad(key) }.padding(horizontal = 16.dp, vertical = 10.dp), style = Dray.Font.headline)
            }
            nothingHeld -> MaxWidth { Skeleton() }
            empty -> Column(Modifier.fill().heightIn(min = 420.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Icon(Icons.AutoMirrored.Outlined.Chat, null, Modifier.size(32.dp), tint = Dray.tertiary)
                Text("No messages yet", Modifier.padding(top = 8.dp), style = Dray.Font.title)
                Text("Send one to start this session.", Modifier.padding(top = 8.dp), style = Dray.Font.subhead.copy(color = Dray.secondary))
            }
        }
    }
}

/** Two fake turns, shimmering, while the first read is out. */
@Composable
private fun Skeleton() {
    Column(verticalArrangement = Arrangement.spacedBy(28.dp)) {
        for ((prompt, bars) in listOf(180 to listOf(1f, 0.92f, 0.6f), 120 to listOf(0.85f, 1f, 0.95f, 0.4f))) {
            Column(Modifier.shimmer(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
                    Box(Modifier.size(prompt.dp, 40.dp).clip(RoundedCornerShape(Dray.Radius.xl)).background(Dray.raised))
                }
                Box(Modifier.fillMaxWidth(0.4f).height(12.dp).clip(RoundedCornerShape(6.dp)).background(Dray.raised.copy(alpha = 0.6f)))
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    for (w in bars) Box(Modifier.fillMaxWidth(w).height(12.dp).clip(RoundedCornerShape(6.dp)).background(Dray.raised))
                }
            }
        }
    }
}

/** "Load earlier": never automatic, so the screen never jumps under a reader mid-sentence. */
@Composable
private fun Older(key: SessionKey) {
    val store = LocalStore.current
    val err = store.olderErrors[key]
    Column(Modifier.fillMaxWidth().heightIn(min = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        err?.let { Text("Couldn't load earlier messages. $it", style = Dray.Font.footnote.copy(color = Dray.secondary)) }
        if (key in store.olderLoading) CircularProgressIndicator(Modifier.size(20.dp), color = Dray.secondary, strokeWidth = 2.dp)
        else Text(
            if (err != null) "Retry" else "Load earlier",
            Modifier.clip(RoundedCornerShape(Dray.Radius.sm)).background(Dray.card).clickable { store.loadOlder(key) }.padding(horizontal = 12.dp, vertical = 8.dp),
            style = Dray.Font.footnoteStrong.copy(color = Dray.secondary),
        )
    }
}

@Composable
private fun RefreshError(err: String, retry: () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Filled.Error, null, Modifier.size(14.dp), tint = Dray.destructive)
        Text("Couldn't load new messages. $err", Modifier.weight(1f, fill = false), style = Dray.Font.footnote.copy(color = Dray.secondary))
        Text("Retry", Modifier.clickable(onClick = retry), style = Dray.Font.footnote)
    }
}

/** The title, then the project and the machine it runs on — never the branch. */
@Composable
private fun TitleBar(key: SessionKey, back: () -> Unit) {
    val store = LocalStore.current
    val item = store.items[key]
    Row(Modifier.fillMaxWidth().height(56.dp).padding(end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Dray.text) }
        Column(Modifier.weight(1f)) {
            Text(item?.title?.ifEmpty { "Untitled" } ?: "", style = Dray.Font.headline, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (item != null) {
                    Icon(Icons.Filled.Folder, null, Modifier.size(11.dp), tint = Dray.tertiary)
                    Text(" ${item.project}", style = Dray.Font.footnote.copy(color = Dray.tertiary), maxLines = 1)
                    Box(Modifier.width(10.dp))
                }
                Icon(Icons.Outlined.Dns, null, Modifier.size(11.dp), tint = Dray.tertiary)
                Text(" ${store.name(key.server)}", style = Dray.Font.footnote.copy(color = Dray.tertiary), maxLines = 1)
            }
        }
        // Off in a bot's chat, whose folder runs no dev server.
        if (store.bot(key) == null) {
            var servers by remember { mutableStateOf(false) }
            IconButton({ servers = true }) { Icon(Icons.Outlined.Language, "Local servers", tint = Dray.text) }
            if (servers) LocalServersSheet(key) { servers = false }
        }
    }
}
