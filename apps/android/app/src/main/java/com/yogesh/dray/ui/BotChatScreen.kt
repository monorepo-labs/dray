package com.yogesh.dray.ui

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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Checklist
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.BotItem
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.Shot
import com.yogesh.dray.model.botItems
import com.yogesh.dray.model.botRows
import com.yogesh.dray.model.currentTool
import com.yogesh.dray.model.inReviewTurn
import com.yogesh.dray.model.plural
import com.yogesh.dray.model.unreadStart
import com.yogesh.dray.store.botChat
import com.yogesh.dray.store.botTasks
import com.yogesh.dray.store.hiddenAsks
import com.yogesh.dray.wire.Bot
import com.yogesh.dray.wire.ImageRef
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * A bot's chat: the conversation across its sessions, a line where it started or messaged a task,
 * merge cards, lessons, and a time label wherever 15 minutes passed between rows. iOS's bot half
 * of `TranscriptView`. `opened` is any session of the chat: an agent switch moves the reply to a
 * newer one, which the screen follows.
 */
@Composable
fun BotChatScreen(opened: SessionKey, bot: Bot, back: () -> Unit, openTask: (SessionKey) -> Unit, openSession: (SessionKey) -> Unit, openSettings: (String) -> Unit) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    val chat = store.botChat(opened.server, bot)
    val key = chat.lastOrNull() ?: opened
    val item = store.items[key]
    val busy = item?.busy == true
    val transcript = store.transcripts[key]
    val tasks = store.botTasks(chat)
    // Set-aside tasks are listed but not counted, as on the Tasks sheet and the desktop.
    val taskCount = tasks.count { store.items[it]?.aside != true }
    val asks = store.asks[key].orEmpty()
    val taskAsks = store.hiddenAsks(tasks)
    val queued = store.queued[key].orEmpty()
    val running = store.tasks[key].orEmpty()
    var showingTasks by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var gallery by remember { mutableStateOf<Pair<List<Shot>, Int>?>(null) }

    // The sessions on screen, oldest first: this one, and the earlier ones an agent switch left,
    // each drawn once the one after it is read back to its start and it is held (`drawnSegments`).
    val segments = run {
        val i = chat.indexOf(key)
        if (i < 0) return@run listOf(key)
        var start = i
        while (start > 0 && store.transcripts[chat[start]]?.olderBefore == null && store.transcripts[chat[start]] != null &&
            store.transcripts[chat[start - 1]] != null) start--
        chat.subList(start, i + 1)
    }
    val hidden = chat.indexOf(segments[0]).let { if (it > 0) chat[it - 1] else null }
    val complete = store.transcripts[segments[0]]?.olderBefore == null && hidden == null
    // An agent switch draws nothing between them: the reader just picked the agent (#1417).
    val items = segments.flatMap { botItems(store.transcripts[it]?.events.orEmpty()) }
    val rows = botRows(items)

    // Where unread replies begin, settled once so reading the chat never moves it.
    var openedUnread by remember { mutableStateOf(false) }
    var upTo by remember { mutableStateOf<String?>(null) }
    var newFrom by remember { mutableStateOf<com.yogesh.dray.model.Unread?>(null) }
    LaunchedEffect(key) {
        val unread = store.items[key]?.status == "completed"
        store.open(key)
        openedUnread = unread
    }
    // A reply that lands while the chat is on screen is read, or coming back to it would draw NEW over it.
    // Composed after the open above, which has already noted whether the chat opened unread.
    LaunchedEffect(item?.status) { if (item?.status == "completed") store.open(key) }
    LaunchedEffect(openedUnread, items.size, complete) {
        if (!openedUnread || newFrom != null) return@LaunchedEffect
        // Taken once the open's read landed, never off the cache alone: replies it brings count as unread.
        if (upTo == null) upTo = items.lastOrNull()?.id ?: return@LaunchedEffect
        unreadStart(items, upTo!!, complete)?.let { newFrom = it }
    }

    val list = rememberLazyListState()
    var follow by remember { mutableStateOf(true) }
    val slack = with(LocalDensity.current) { 40.dp.toPx() }
    LaunchedEffect(list) {
        snapshotFlow { Triple(list.isScrollInProgress, list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset) }.collect { (scrolling, i, off) ->
            if (scrolling) follow = i == 0 && off < slack
        }
    }
    val newest = listOf(transcript?.events?.lastOrNull()?.id, asks.size + taskAsks.size, busy, queued.size)
    LaunchedEffect(newest) { if (follow) list.scrollToItem(0) }
    LaunchedEffect(store.sends[key]) {
        follow = true
        list.scrollToItem(0)
    }
    LaunchedEffect(key) {
        delay(500); if (follow) list.scrollToItem(0)
    }

    CompositionLocalProvider(
        LocalImageServer provides key.server,
        LocalCallSession provides key,
        LocalOpenImage provides { ref: ImageRef ->
            val shots = items.filterIsInstance<BotItem.User>().flatMap { it.images }.map { Shot(it, "Image", it.path ?: it.url) }
                .ifEmpty { listOf(Shot(ref, "Image", ref.path ?: ref.url)) }
            gallery = shots to shots.indexOfFirst { it.ref == ref }.coerceAtLeast(0)
        },
    ) {
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().background(Dray.page).statusBarsPadding().navigationBarsPadding().imePadding()) {
                Row(Modifier.fillMaxWidth().height(60.dp).padding(end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Dray.text) }
                    Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) { BotTitle(bot) { editing = true } }
                    // The PR button's place: a bot has no PR, and its tasks are what the list leaves out.
                    Row(
                        Modifier.clip(RoundedCornerShape(Dray.Radius.md)).clickable { showingTasks = true }.padding(10.dp)
                            .semantics { contentDescription = if (taskCount == 0) "Tasks" else "Tasks, $taskCount" },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Outlined.Checklist, null, Modifier.size(22.dp), tint = Dray.text)
                        if (taskCount > 0) Text(" $taskCount", style = Dray.Font.headline)
                    }
                }
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
                            item("stalls") { MaxWidth { StalledCard(key, bot.id, tasks, openTask) } }
                            // Answered by the task's own key, so the reply reaches its server, not this chat's.
                            taskAsks.reversed().forEach { (k, e) ->
                                item("task-ask-${e.id}") {
                                    MaxWidth {
                                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                            Text(store.items[k]?.title ?: "Task", Modifier.padding(start = 2.dp), style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = 1)
                                            AskCard(k, e)
                                        }
                                    }
                                }
                            }
                            asks.reversed().forEach { ask -> item("ask-${ask.id}") { MaxWidth { AskCard(key, ask) } } }
                            item("status") {
                                MaxWidth {
                                    val events = transcript?.events.orEmpty()
                                    when {
                                        // A review's turn draws nothing, its orb included.
                                        busy -> if (!inReviewTurn(events)) OrbLine(OrbKind.Working, currentTool(events) ?: "Working")
                                        // A bot's runs list under its tasks, as on desktop.
                                        running.isNotEmpty() -> OrbLine(
                                            OrbKind.Background, "${plural(running.size, "background task")} running",
                                            Modifier.clickable { showingTasks = true },
                                        )
                                    }
                                }
                            }
                            if (transcript != null) store.transcriptErrors[key]?.let { err ->
                                item("refresh-error") {
                                    MaxWidth {
                                        Text("Couldn't load new messages. ${sentence(err)}", Modifier.clickable { store.retryLoad(key) }, style = Dray.Font.footnote.copy(color = Dray.secondary))
                                    }
                                }
                            }
                            queued.reversed().forEach { q -> item("queued-${q.id}") { MaxWidth { BotUserBubble(q.text) } } }
                            for (i in rows.indices.reversed()) item(rows[i].id) {
                                MaxWidth { BotChatRow(key, rows, i, items, newFrom?.at, openTask, openSession) }
                            }
                            if (transcript == null) item("placeholder") {
                                MaxWidth {
                                    val err = store.transcriptErrors[key]
                                    if (err != null) Text("Couldn't load this chat. ${sentence(err)}", Modifier.clickable { store.retryLoad(key) }, style = Dray.Font.subhead.copy(color = Dray.secondary))
                                    else Box(Modifier.fillMaxWidth().heightIn(min = 200.dp), contentAlignment = Alignment.Center) {
                                        CircularProgressIndicator(Modifier.size(20.dp), color = Dray.secondary, strokeWidth = 2.dp)
                                    }
                                }
                            }
                            if (!complete && transcript != null) item("older") {
                                MaxWidth {
                                    val top = segments[0]
                                    Box(Modifier.fillMaxWidth().heightIn(min = 40.dp), contentAlignment = Alignment.Center) {
                                        if (top in store.olderLoading) CircularProgressIndicator(Modifier.size(20.dp), color = Dray.secondary, strokeWidth = 2.dp)
                                        else Text(
                                            if (store.olderErrors[top] != null) "Retry" else "Load earlier",
                                            Modifier.clip(RoundedCornerShape(Dray.Radius.sm)).background(Dray.card).clickable {
                                                // The page above, or past the top session's start, the session before it.
                                                if (store.transcripts[top]?.olderBefore != null) store.loadOlder(top)
                                                else hidden?.let { scope.launch { store.load(it) } }
                                            }.padding(horizontal = 12.dp, vertical = 8.dp),
                                            style = Dray.Font.footnoteStrong.copy(color = Dray.secondary),
                                        )
                                    }
                                }
                            }
                            item("top") { Spacer(Modifier.height(4.dp)) }
                        }
                    }
                    Box(Modifier.align(Alignment.TopCenter)) { SessionBanner(key.server) { openSettings(key.server) } }
                }
                if (item != null) ReplyDock(key)
            }
            gallery?.let { (shots, at) -> ImageViewer(shots, at) { gallery = null } }
        }
    }

    if (showingTasks) BotTasksSheet(key.server, tasks, openTask) { showingTasks = false }
    if (editing) BotSheet(editing = key.server to bot, close = { editing = false })
}
