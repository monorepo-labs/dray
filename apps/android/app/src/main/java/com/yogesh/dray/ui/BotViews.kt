package com.yogesh.dray.ui

import android.content.Context
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yogesh.dray.model.BotItem
import com.yogesh.dray.model.BotRow
import com.yogesh.dray.model.BotVerdict
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.chatTime
import com.yogesh.dray.model.lessonKind
import com.yogesh.dray.model.prStatus
import com.yogesh.dray.model.previewLine
import com.yogesh.dray.model.runningLabel
import com.yogesh.dray.model.verdictOf
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.store.Stall
import com.yogesh.dray.store.botChat
import com.yogesh.dray.store.botTasks
import com.yogesh.dray.store.ensureMarks
import com.yogesh.dray.store.hiddenAsks
import com.yogesh.dray.store.judgedStalls
import com.yogesh.dray.store.marksRead
import com.yogesh.dray.store.mergeTask
import com.yogesh.dray.store.stalls
import com.yogesh.dray.wire.Bot
import com.yogesh.dray.wire.ImageRef
import com.yogesh.dray.wire.MergeCard
import com.yogesh.dray.wire.PrMark
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.parseDate
import com.yogesh.dray.wire.shortAge
import com.yogesh.dray.wire.str
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// BotViews.swift, restated: the list's bot row, the bot chat's rows, merge cards, Waiting on you and the Tasks sheet.

/** A bot row's unread count: the desktop's dark `oklch(0.55 0.2 25)`, deeper so white reads on it. */
private val unread = Color(0xFFCC272E)

// The list's row

/**
 * A bot in the list, the desktop sidebar's inbox row: its face, its name over how long since it
 * last spoke, and one line of its newest reply — typing dots while it works. The face carries the
 * state: yellow while it waits on the reader, the unread count once a reply lands.
 */
@Composable
fun BotListRow(server: String, bot: Bot, chat: SessionKey?, onClick: () -> Unit) {
    val store = LocalStore.current
    val item = chat?.let { store.items[it] }
    // A task's card is drawn in this chat, so the bot waits on the reader too.
    val asking = (chat?.let { store.isAsking(it) } ?: false) || store.hiddenAsks(store.botTasks(store.botChat(server, bot))).isNotEmpty()
    val isUnread = item?.status == "completed"
    val preview = chat?.let { store.botState.previews[it] }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp).clip(RoundedCornerShape(Dray.Radius.md)).clickable(onClick = onClick)
            .padding(start = 6.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box {
            BotFace(bot, 48.dp)
            Box(Modifier.align(Alignment.BottomEnd)) { Badge(asking, isUnread, preview?.replies ?: 0) }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    bot.name, Modifier.weight(1f),
                    style = Dray.Font.body.copy(fontWeight = if (isUnread) FontWeight.SemiBold else FontWeight.Normal),
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                if (server in store.lost) Icon(Icons.Outlined.WifiOff, "Server offline", Modifier.size(14.dp), tint = Dray.tertiary)
                else parseDate(item?.modified)?.let { Text(shortAge(it), style = Dray.Font.footnote.copy(color = Dray.tertiary)) }
            }
            // No line at all with nothing to say, so the name sits level with the face.
            val line = previewLine(preview?.text ?: bot.greeting?.lastOrNull() ?: bot.welcome ?: "")
            if (item?.busy == true && !asking) {
                Box(Modifier.heightIn(min = 20.dp), contentAlignment = Alignment.CenterStart) { TypingDots() }
            } else if (line.isNotEmpty()) {
                Text(line, style = Dray.Font.subhead.copy(color = Dray.secondary), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** Ringed in the page's colour, the desktop's cut-out hole. */
@Composable
private fun Badge(asking: Boolean, isUnread: Boolean, replies: Int) {
    if (asking) {
        Box(
            Modifier.offset(x = 1.dp).size(12.dp).clip(CircleShape).background(Dray.page).padding(2.dp).clip(CircleShape).background(Dray.accent)
                .semantics { contentDescription = "Waiting on you" },
        )
    } else if (isUnread) {
        Box(
            Modifier.offset(x = 2.dp, y = 1.dp).clip(CircleShape).background(Dray.page).padding(2.dp)
                .heightIn(min = 18.dp).widthIn(min = 18.dp).clip(CircleShape).background(unread)
                .semantics { contentDescription = if (replies == 1) "1 new reply" else "$replies new replies" },
            contentAlignment = Alignment.Center,
        ) {
            if (replies > 0) Text("$replies", Modifier.padding(horizontal = 5.dp), style = Dray.Font.footnoteStrong.copy(fontSize = 11.sp, lineHeight = 14.sp))
        }
    }
}

/** A bot's header: a bot's folder is no project, so its face and name as a chip, which opens the bot. */
@Composable
fun BotTitle(bot: Bot, modifier: Modifier = Modifier, edit: () -> Unit) {
    Row(
        modifier.widthIn(max = 240.dp).height(44.dp).clip(CircleShape).background(Dray.card).border(1.dp, Dray.hairline, CircleShape)
            .clickable(onClickLabel = "Edit bot", onClick = edit).padding(start = 6.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        BotFace(bot, 32.dp)
        Text(bot.name, style = Dray.Font.headline, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// The chat

/** Between two sessions of one bot chat: the agent the later one runs. */
@Composable
fun SwitchLine(harness: String?) {
    Text(
        "Switched to ${harness?.let { Picks.agentLabels[it] ?: it } ?: "another agent"}",
        Modifier.fillMaxWidth(), style = Dray.Font.footnote.copy(color = Dray.tertiary), textAlign = TextAlign.Center,
    )
}

/** Before the first row, and before any row 15 minutes or more after the one above. */
fun timeLabel(rows: List<BotRow>, i: Int): String? {
    val at = parseDate(rows[i].ts) ?: return null
    if (i > 0) {
        val before = parseDate(rows[i - 1].ts)
        if (before != null && at - before < 15 * 60_000L) return null
    }
    return chatTime(at)
}

/** A card the reader has written three times past shrinks to its one line. */
fun lateCard(items: List<BotItem>, row: BotRow): Boolean {
    val card = (row as? BotRow.One)?.item as? BotItem.Card ?: return false
    val i = items.indexOfFirst { it.id == card.id }
    if (i < 0) return false
    return items.subList(i + 1, items.size).count { it is BotItem.User } >= 3
}

/** One row of a bot's chat with what goes above it: the NEW divider and a time label. */
@Composable
fun BotChatRow(key: SessionKey, rows: List<BotRow>, i: Int, items: List<BotItem>, newFrom: String?, openTask: (SessionKey) -> Unit, openSession: (SessionKey) -> Unit) {
    val row = rows[i]
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(28.dp)) {
        if (row.id == newFrom) NewDivider()
        timeLabel(rows, i)?.let {
            Text(it, Modifier.fillMaxWidth().padding(top = 8.dp), style = Dray.Font.footnote.copy(color = Dray.tertiary), textAlign = TextAlign.Center)
        }
        val item = (row as? BotRow.One)?.item
        if (item is BotItem.SwitchTo) SwitchLine(item.harness)
        else BotRowView(key, row, lateCard(items, row), openTask, openSession)
    }
}

/**
 * An agent's reply as a bot chat draws it: a card-filled bubble short of the trailing edge, the
 * reader's reaction on its bottom corner, beside what was read. `modifier` is the bubble's own.
 *
 * A reaction lands on a message already read, so it must move nothing: the badge sits out to the
 * side, in the room the bubble stops short of, and inside the bubble's own height, which one line
 * of text gives it. Hung under the bubble it needed padding to clear the next row, and the chat
 * jumped. It laps the bubble by its padding less the ring, so no text is under it.
 */
@Composable
fun ReplyBubble(text: String, reaction: String? = null, modifier: Modifier = Modifier) {
    Box(Modifier.padding(end = 32.dp)) {
        Box(modifier.clip(RoundedCornerShape(Dray.Radius.xl)).background(Dray.card).padding(horizontal = 12.dp, vertical = 10.dp)) {
            MarkdownText(text)
        }
        reaction?.let { Box(Modifier.align(Alignment.BottomEnd).hung(x = (-8).dp, y = (-40).dp)) { ReactionBadge(it, mine = true) } }
    }
}

/** Draws its content `x`, `y` from where it is put and takes no room there, so a badge landing resizes nothing. */
private fun Modifier.hung(x: Dp, y: Dp = 0.dp) = layout { measurable, _ ->
    val placeable = measurable.measure(Constraints())
    layout(0, 0) { placeable.placeRelative(x.roundToPx(), y.roundToPx()) }
}

/** Where the replies the reader has not seen begin, as a messenger marks it. */
@Composable
fun NewDivider() {
    Row(Modifier.fillMaxWidth().semantics { contentDescription = "New messages" }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.weight(1f).height(1.dp).background(Dray.border))
        Text("NEW", style = Dray.Font.footnote.copy(fontSize = 11.sp, letterSpacing = 0.3.sp, color = Dray.secondary))
        Box(Modifier.weight(1f).height(1.dp).background(Dray.border))
    }
}

/**
 * The reader's own words in a bot's chat: the sent bubble, the bot's reaction out to the side of
 * its top corner, where it lands without moving anything — see [ReplyBubble].
 */
@Composable
fun BotUserBubble(text: String, images: List<ImageRef> = emptyList(), reaction: String? = null) {
    Column(Modifier.fillMaxWidth().padding(start = 48.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // A message of pictures alone has no bubble, so the badge sits on the first one's corner.
        if (images.isNotEmpty()) BoxWithConstraints {
            Thumbnails(images, end = true)
            val wide = minOf(maxWidth, 72.dp * images.size + 4.dp * (images.size - 1))
            if (text.isEmpty()) reaction?.let { Box(Modifier.align(Alignment.TopEnd).hung(x = -wide - 32.dp)) { ReactionBadge(it) } }
        }
        if (text.isNotEmpty()) {
            Box {
                Text(
                    text,
                    Modifier.clip(RoundedCornerShape(Dray.Radius.xl)).background(Dray.sent).padding(horizontal = 14.dp, vertical = 10.dp),
                    style = Dray.Font.body.copy(color = Dray.onSent),
                )
                reaction?.let { Box(Modifier.align(Alignment.TopStart).hung(x = (-32).dp)) { ReactionBadge(it) } }
            }
        } else if (images.isEmpty()) reaction?.let { ReactionBadge(it) }
    }
}

@Composable
private fun BotRowView(key: SessionKey, row: BotRow, late: Boolean, openTask: (SessionKey) -> Unit, openSession: (SessionKey) -> Unit) {
    val store = LocalStore.current
    var expanded by remember { mutableStateOf(false) }

    /** The task by its index entry, or by a prefix of its id as `dray session send` takes one. */
    fun task(id: String): SessionKey? {
        val exact = SessionKey(key.server, id)
        if (store.items[exact] != null) return exact
        val hits = store.items.keys.filter { it.server == key.server && it.id.startsWith(id.lowercase()) }
        return hits.singleOrNull()
    }

    @Composable
    fun line(verb: String, chip: @Composable () -> Unit) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(verb, style = Dray.Font.subhead.copy(color = Dray.tertiary))
            chip()
        }
    }

    /** `fallback` names a task gone from the index, as a settled one is. */
    @Composable
    fun taskChip(id: String, fallback: String? = null) {
        val found = task(id)
        val title = found?.let { store.items[it]?.title }?.ifEmpty { null } ?: fallback ?: "Task"
        Chip(found?.id ?: id, null, title, found?.let { { openTask(it) } })
    }

    @Composable
    fun botChip(id: String?, name: String) {
        val bots = store.bots[key.server].orEmpty()
        val named = bots.filter { it.name.equals(name, ignoreCase = true) }
        val bot = bots.firstOrNull { it.id == id } ?: bots.firstOrNull { it.id == name } ?: named.singleOrNull()
        val chat = bot?.let { store.botChat(key.server, it).lastOrNull() }
        Chip(bot?.id ?: id ?: name, bot, bot?.name ?: name, chat?.let { { openSession(it) } })
    }

    when (row) {
        is BotRow.Talk -> {
            val seen = mutableSetOf<String>()
            val parties = row.targets.filter { seen.add(task(it)?.id ?: it) }
            if (parties.size == 1) line("Messaged") { taskChip(parties[0]) }
            else Column(Modifier.animateContentSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                line("Messaged") {
                    Row(Modifier.clickable { expanded = !expanded }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy((-8).dp)) {
                            for (p in parties.take(3)) BotFace(task(p)?.id ?: p, size = 20.dp)
                        }
                        Text("${parties.size} tasks", style = Dray.Font.subhead)
                        Chevron(expanded)
                    }
                }
                if (expanded) Column(
                    // The rail the opened list hangs on, as iOS draws it.
                    Modifier.drawBehind { drawLine(Dray.border, Offset.Zero, Offset(0f, size.height), 1.dp.toPx()) }.padding(start = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) { for (p in parties) taskChip(p) }
            }
        }
        is BotRow.One -> when (val item = row.item) {
            is BotItem.User -> BotUserBubble(item.text, item.images, item.reaction)
            is BotItem.Assistant -> Reactable(SessionKey(key.server, item.sessionId ?: key.id), item.id, item.reaction) {
                ReplyBubble(item.text, item.reaction, it)
            }
            is BotItem.Notice -> FailureRow(item.text)
            is BotItem.Card -> MergeCardView(key.server, item.card, late, openTask)
            is BotItem.Task -> line("Started a new task") { taskChip(item.sessionId, item.title) }
            is BotItem.BotMessage -> Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                line("Message from") { botChip(item.botId, item.title) }
                BotUserBubble(item.text)
            }
            is BotItem.BotSent -> line("Messaged") { botChip(item.botId, item.name) }
            is BotItem.Learned -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(lessonKind(item.lesson), style = Dray.Font.subhead.copy(color = Dray.tertiary))
                Text(
                    item.lesson.summary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = Dray.Font.subhead.copy(
                        color = Dray.text.copy(alpha = if (item.undone) 0.5f else 0.8f),
                        textDecoration = if (item.undone) TextDecoration.LineThrough else null,
                    ),
                )
            }
            is BotItem.Sent, is BotItem.SwitchTo -> {}
        }
    }
}

/** A face and a name, inline in a line of the chat; a tap opens it where there is something to open. */
@Composable
private fun Chip(seed: String, bot: Bot?, title: String, open: (() -> Unit)?, size: androidx.compose.ui.unit.Dp = 18.dp) {
    Row(
        Modifier.clip(RoundedCornerShape(6.dp)).clickable(enabled = open != null) { open?.invoke() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (bot != null) BotFace(bot, size) else BotFace(seed, size = size)
        Text(title, style = Dray.Font.subhead, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// Merge card

/**
 * The chat's merge card: the task and its PR's state, with Merge once GitHub says it can land, or
 * Fix conflicts. One line once merged or long past.
 */
@Composable
fun MergeCardView(server: String, card: MergeCard, compact: Boolean, openTask: (SessionKey) -> Unit) {
    val store = LocalStore.current
    val uri = LocalUriHandler.current
    val pr = store.marks[com.yogesh.dray.model.ProjectKey(server, card.prPath)]?.values?.firstOrNull { it.number == card.number }
    val read = store.marksRead(server, card.prPath)
    // The task where the phone can reach it: the chat's server, or a shared machine's. Null where it is not shared.
    val task = if (card.machine == null) SessionKey(server, card.taskId)
    else store.servers.firstOrNull { it.via?.parent == server && (it.via.machine == card.machine || it.name == card.machine) }?.let { SessionKey(it.id, card.taskId) }
    val title = task?.let { store.items[it]?.title }?.ifEmpty { null } ?: card.title
    val verdict = pr?.let { verdictOf(it) }
    // Said, never enforced: merging over it is the reader's call.
    val work = if (pr?.state == "MERGED") null else task?.let { store.tasks[it] }?.let { runningLabel(it) }
    LaunchedEffect(card.prPath) { store.ensureMarks(server, card.prPath) }

    if (compact || pr?.state == "MERGED" || (read && pr == null)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            pr?.let { PrGlyph(it, 14.dp) }
            Text(
                if (pr?.state == "MERGED") "Merged #${card.number}" else "#${card.number}",
                Modifier.clickable { runCatching { uri.openUri(card.url) } }, style = Dray.Font.subhead.copy(color = Dray.secondary),
            )
            Text("·", style = Dray.Font.subhead.copy(color = Dray.tertiary))
            Box(Modifier.weight(1f, fill = false)) { Chip(card.taskId, null, title, task?.let { { openTask(it) } }, 16.dp) }
            work?.let {
                Orb(OrbKind.Background, 14.dp)
                Text(it, style = Dray.Font.subhead.copy(color = Dray.secondary), maxLines = 1)
            }
            Spacer(Modifier.weight(1f))
            if (pr != null && verdict != null) MergeControl(server, card, pr, verdict, task)
        }
    } else {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.group)).background(Dray.card)
                .border(1.dp, Dray.hairline, RoundedCornerShape(Dray.Radius.group)).padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            BotFace(card.taskId, size = 28.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    title, Modifier.clickable(enabled = task != null) { task?.let(openTask) },
                    style = Dray.Font.body, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    pr?.let { PrGlyph(it, 14.dp) }
                    Text("#${card.number}", Modifier.clickable { runCatching { uri.openUri(card.url) } }, style = Dray.Font.footnote.copy(color = Dray.secondary))
                    if (pr?.state == "OPEN" && pr.checksState == "RUNNING") ChecksSpinner(13.dp)
                    words(pr, verdict)?.let { (text, tone) -> Text(text, style = Dray.Font.footnote.copy(color = tone), maxLines = 1) }
                    work?.let {
                        Text("·", style = Dray.Font.footnote.copy(color = Dray.tertiary))
                        Orb(OrbKind.Background, 14.dp)
                        Text(it, style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            if (pr != null && verdict != null) MergeControl(server, card, pr, verdict, task)
        }
    }
}

private fun words(pr: PrMark?, verdict: BotVerdict?): Pair<String, Color>? {
    if (pr == null || verdict == null) return "Reading status…" to Dray.tertiary
    return when (verdict) {
        BotVerdict.Merged -> "Merged" to Dray.tertiary
        BotVerdict.Closed -> "Closed without merging" to Dray.tertiary
        BotVerdict.Unknown -> "Checking mergeability…" to Dray.accent
        BotVerdict.Behind -> "Behind base" to Dray.accent
        BotVerdict.Blocked -> "Blocked" to Dray.accent
        else -> null
    }
}

@Composable
private fun MergeControl(server: String, card: MergeCard, pr: PrMark, verdict: BotVerdict, task: SessionKey?) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    var asked by remember { mutableStateOf(false) }
    if (pr.state == "OPEN" && !pr.isDraft && verdict == BotVerdict.Ready) {
        MergeTaskButton(server, card.taskId, card.prPath, card.number, card.branch)
    } else if (pr.state == "OPEN" && verdict == BotVerdict.Conflict && task != null) {
        Text(
            if (asked) "Asked the task" else "Fix conflicts",
            Modifier.height(34.dp).clip(CircleShape).background(Dray.raised).clickable(enabled = !asked) {
                asked = true
                scope.launch {
                    if (!store.send(task, "PR #${card.number} has merge conflicts with its base branch. Fix them and push.")) asked = false
                }
            }.padding(horizontal = 14.dp, vertical = 7.dp),
            style = Dray.Font.pill,
        )
    }
}

private enum class MergeMethod(val label: String) { squash("Squash and merge"), merge("Create a merge commit"), rebase("Rebase and merge") }

private fun Context.botPrefs() = getSharedPreferences("bots", Context.MODE_PRIVATE)

/** Merge for a bot's task: the method kept, a confirm, then the task settled. */
@Composable
fun MergeTaskButton(server: String, taskId: String, cwd: String, number: Int, branch: String, modifier: Modifier = Modifier) {
    val store = LocalStore.current
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    var confirming by remember { mutableStateOf(false) }
    var merging by remember { mutableStateOf(false) }
    val kept = remember { MergeMethod.entries.firstOrNull { it.name == context.botPrefs().getString("mergeMethod", null) } ?: MergeMethod.squash }
    Text(
        if (merging) "Merging…" else "Merge",
        modifier.height(34.dp).clip(CircleShape).background(Dray.merge).clickable(enabled = !merging) { confirming = true }
            .padding(horizontal = 16.dp, vertical = 7.dp),
        style = Dray.Font.pill.copy(color = Color.White),
    )
    if (confirming) AlertDialog(
        onDismissRequest = { confirming = false },
        containerColor = Dray.card,
        title = { Text("${kept.label} #$number?", style = Dray.Font.headline) },
        text = {
            Column {
                Text("The task settles once it lands.", style = Dray.Font.subhead.copy(color = Dray.secondary))
                Spacer(Modifier.height(12.dp))
                // The kept method first, so a second merge is one tap.
                for (m in listOf(kept) + MergeMethod.entries.filter { it != kept }) Text(
                    m.label,
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.md)).clickable {
                        confirming = false
                        merging = true
                        context.botPrefs().edit().putString("mergeMethod", m.name).apply()
                        scope.launch {
                            val ok = store.mergeTask(server, taskId, cwd, number, branch, m.name)
                            haptics.performHapticFeedback(if (ok) HapticFeedbackType.LongPress else HapticFeedbackType.TextHandleMove)
                            merging = false
                        }
                    }.padding(vertical = 12.dp, horizontal = 4.dp),
                    style = Dray.Font.body.copy(color = if (m == MergeMethod.squash) Dray.text else Dray.text),
                )
            }
        },
        confirmButton = {},
        dismissButton = { TextButton({ confirming = false }) { Text("Cancel", color = Dray.secondary) } },
    )
}

// Waiting on you

/** Rows drawn before "Show N more", which opens them all in a sheet, so a long card doesn't push the chat off screen. */
private const val STALL_ROWS_SHOWN = 2

/**
 * The card at the foot of a bot's chat: its tasks that wait on the reader. A tap opens in a sheet
 * what the bot said about the task (`bot_task_reply`); with none, the tap opens the task. X puts
 * the card away until one of them moves and stalls again.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StalledCard(chat: SessionKey, botId: String, tasks: List<SessionKey>, openTask: (SessionKey) -> Unit) {
    val store = LocalStore.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var dismissed by remember { mutableStateOf(context.botPrefs().getString("dismissedStalls", "").orEmpty()) }
    var picked by remember { mutableStateOf<Pair<Stall, String>?>(null) }
    var reading by remember { mutableStateOf<String?>(null) }
    var all by remember { mutableStateOf(false) }
    // Stalls ripen with time alone, so the card looks again each minute.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(60_000); now = System.currentTimeMillis() } }
    // Tasks are hidden, so the list never reads their repos' marks, and a ready PR would sit here with no Merge.
    LaunchedEffect(tasks) {
        tasks.mapNotNull { k -> store.items[k]?.let { k.server to it.projectPath } }.toSet().forEach { (s, p) -> store.ensureMarks(s, p) }
    }

    fun visible(): List<Stall> {
        val gone = dismissed.split("\n").toSet()
        val card = store.judgedStalls(chat.server, botId, tasks, now) ?: store.stalls(tasks, now)
        return card.filter { it.id !in gone }
    }

    /** Reads the bot's reply before deciding: a sheet for it, or the task where there is none or the read failed. */
    fun pick(s: Stall) {
        if (reading != null) return
        reading = s.id
        scope.launch {
            val text = runCatching {
                store.call(chat.server, "bot_task_reply", jsonOf("sessionId" to chat.id, "taskId" to s.task.id), timeoutMs = 8_000).str
            }.getOrNull()
            reading = null
            if (text != null) picked = s to text
            else if (!s.offline) { all = false; openTask(s.task) }
        }
    }

    val rows = visible()
    if (rows.isNotEmpty()) {
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.lg)).border(1.dp, Dray.border, RoundedCornerShape(Dray.Radius.lg)).padding(4.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(Modifier.padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Waiting on you", Modifier.weight(1f), style = Dray.Font.footnote.copy(color = Dray.secondary))
                Box(
                    Modifier.size(28.dp).clip(CircleShape).clickable {
                        // Capped, so years of dismissals never grow without end.
                        dismissed = (dismissed.split("\n").filter { it.isNotEmpty() } + rows.map { it.id }).takeLast(200).joinToString("\n")
                        context.botPrefs().edit().putString("dismissedStalls", dismissed).apply()
                    }.semantics { contentDescription = "Dismiss" },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Filled.Close, null, Modifier.size(14.dp), tint = Dray.tertiary) }
            }
            for (s in rows.take(STALL_ROWS_SHOWN)) StallRowView(chat, s, reading == s.id) { pick(s) }
            if (rows.size > STALL_ROWS_SHOWN) Text(
                "Show ${rows.size - STALL_ROWS_SHOWN} more",
                Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.md)).clickable { all = true }.padding(vertical = 8.dp),
                style = Dray.Font.footnote.copy(color = Dray.secondary), textAlign = TextAlign.Center,
            )
        }
    }

    if (all) ModalBottomSheet({ all = false }, containerColor = Dray.page) {
        Column(Modifier.padding(horizontal = 8.dp).padding(bottom = 24.dp).verticalScroll(rememberScrollState())) {
            CountTitle("Waiting on you", rows.size, Modifier.padding(start = 12.dp, bottom = 8.dp))
            for (s in rows) StallRowView(chat, s, reading == s.id) { pick(s) }
        }
    }
    picked?.let { (s, text) ->
        BotReplySheet(chat, s.task, s.item.title, text, s.item, close = { picked = null }) {
            picked = null
            all = false
            if (!s.offline) openTask(s.task)
        }
    }
}

@Composable
private fun StallRowView(chat: SessionKey, s: Stall, reading: Boolean, onClick: () -> Unit) {
    val need = s.judged?.need ?: s.item.need?.let { n ->
        val at = parseDate(n.at)
        val moved = parseDate(s.item.modified)
        if (at != null && moved != null && at >= moved) n.text else null
    }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.md)).clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        BotFace(s.task.id, size = 32.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(s.item.title.ifEmpty { "Untitled" }, Modifier.weight(1f, fill = false), style = Dray.Font.subhead, maxLines = 1, overflow = TextOverflow.Ellipsis)
                s.pr?.let {
                    PrGlyph(it, 13.dp)
                    Text("#${it.number}", style = Dray.Font.footnote.copy(color = if (s.ready) Dray.add else Dray.secondary))
                }
                Spacer(Modifier.weight(1f))
                if (s.ready && s.pr != null) {
                    val repo = s.judged?.repo
                    when {
                        s.checking -> Text("Checking…", style = Dray.Font.footnote.copy(color = Dray.tertiary))
                        // Its machine is down or out of reach: the bot's server merges by repo.
                        s.offline && repo != null -> MergeTaskButton(chat.server, s.task.id, "github:$repo", s.pr.number, s.pr.headRefName)
                        !s.offline -> MergeTaskButton(s.task.server, s.task.id, s.item.projectPath, s.pr.number, s.pr.headRefName)
                    }
                }
                when {
                    reading -> CircularProgressIndicator(Modifier.size(12.dp), color = Dray.tertiary, strokeWidth = 1.5.dp)
                    s.offline -> Icon(Icons.Outlined.WifiOff, "Offline · last known state", Modifier.size(13.dp), tint = Dray.tertiary)
                    else -> parseDate(s.item.modified)?.let { Text(shortAge(it), style = Dray.Font.footnote.copy(color = Dray.tertiary)) }
                }
            }
            if (need != null) Text(need, style = Dray.Font.subhead.copy(color = Dray.text.copy(alpha = 0.7f)))
            // A need may never come (bot asleep, nothing to add), so no skeleton waits on one.
            else if (!s.ready) Text("Waiting for your reply", style = Dray.Font.subhead.copy(color = Dray.secondary))
        }
    }
}

/** A sheet's title with its count beside it, quieter, as the desktop's tab headers draw it. */
@Composable
fun CountTitle(title: String, count: Int, modifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = Dray.Font.headline)
        Text("$count", style = Dray.Font.headline.copy(color = Dray.tertiary))
    }
}

/** What the bot said about a Waiting on you task, the desktop's `BotReply` in a sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotReplySheet(chat: SessionKey, task: SessionKey, title: String, text: String, row: SessionItem, close: () -> Unit, open: () -> Unit) {
    val store = LocalStore.current
    // A task on a machine this phone holds no row for still has its reply in the bot's log: the card's own copy stands in.
    val held = remember(task) { store.items[task] != null }
    val item = store.items[task] ?: row
    val pr = store.prMark(task, item)
    // A merge, or a held task going away, settles it: nothing left to read or open.
    val gone = (held && store.items[task] == null) || pr?.let { prStatus(it) } == "merged"
    LaunchedEffect(gone) { if (gone) close() }
    ModalBottomSheet(close, containerColor = Dray.page) {
        androidx.compose.runtime.CompositionLocalProvider(LocalImageServer provides chat.server) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 32.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(title.ifEmpty { "Untitled" }, Modifier.weight(1f), style = Dray.Font.headline)
                    if (held && pr != null && prStatus(pr) == "ready") MergeTaskButton(task.server, task.id, item.projectPath, pr.number, pr.headRefName)
                }
                ReplyBubble(text)
                Row(
                    Modifier.height(34.dp).clip(CircleShape).background(Dray.raised).clickable(onClick = open).padding(horizontal = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text("Open task", style = Dray.Font.pill.copy(color = Dray.secondary))
                    Icon(Icons.AutoMirrored.Filled.OpenInNew, null, Modifier.size(13.dp), tint = Dray.secondary)
                }
            }
        }
    }
}

// Tasks

/**
 * A bot's tasks, which the list leaves out, grouped as the desktop Tasks tab does: pinned, then
 * waiting on the reader, a PR ready to merge, one about to be, idle, working, set-aside ones last
 * and faded. A tap opens one over the bot's chat.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotTasksSheet(server: String, tasks: List<SessionKey>, open: (SessionKey) -> Unit, dismiss: () -> Unit) {
    val store = LocalStore.current
    LaunchedEffect(Unit) {
        tasks.mapNotNull { k -> store.items[k]?.let { k.server to it.projectPath } }.toSet().forEach { (s, p) -> store.ensureMarks(s, p) }
    }

    /** The state a task files under, the desktop's `rowState`: the PR wins over working, since merging is what the reader came for. */
    fun rank(key: SessionKey, item: SessionItem): Int {
        if (store.isAsking(key)) return 0
        val pr = store.prMark(key, item)
        if (pr != null && pr.state == "OPEN" && !pr.isDraft) {
            if (verdictOf(pr) == BotVerdict.Ready) return 1
            if (prStatus(pr) in setOf("checksRunning", "needsReview", "unknown")) return 2
        }
        if (item.busy || store.inBackground(key)) return 4
        return 3
    }

    val ranked = tasks.mapIndexedNotNull { i, k -> store.items[k]?.let { Triple(k, it, rank(k, it) to i) } }
        .sortedWith(compareBy({ it.third.first }, { it.third.second }))
    // Setting aside unpins, so the two never meet.
    val pinned = ranked.filter { it.second.pinned == true && it.second.aside != true }.map { it.first }
    val aside = ranked.filter { it.second.aside == true }.map { it.first }
    val rest = ranked.filter { it.second.aside != true && it.second.pinned != true }
    val runs = mutableListOf<List<SessionKey>>()
    if (rest.size < 3) {
        if (rest.isNotEmpty()) runs += rest.map { it.first }
    } else {
        // A run of one between two breaks reads as a heading, so single neighbours share one.
        var into: Int? = null
        for (state in 0..4) {
            val rows = rest.filter { it.third.first == state }.map { it.first }
            if (rows.isEmpty()) continue
            if (rows.size > 1) { runs += rows; into = null }
            else if (into != null) runs[into] = runs[into] + rows
            else { runs += rows; into = runs.lastIndex }
        }
    }
    if (aside.isNotEmpty()) runs += aside

    ModalBottomSheet(dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false), containerColor = Dray.card) {
        Column(Modifier.padding(horizontal = 8.dp).padding(bottom = 24.dp).verticalScroll(rememberScrollState())) {
            // Set-aside tasks are listed but not counted, as the desktop's Tasks tab counts.
            CountTitle("Tasks", tasks.count { store.items[it]?.aside != true }, Modifier.padding(start = 12.dp, bottom = 12.dp))
            if (tasks.isEmpty()) Text(
                "Nothing handed off yet. Work this bot starts shows up here.",
                Modifier.fillMaxWidth().padding(vertical = 32.dp).wrapContentWidth().widthIn(max = 280.dp),
                style = Dray.Font.subhead.copy(color = Dray.secondary), textAlign = TextAlign.Center,
            )
            if (pinned.isNotEmpty()) {
                Text("Pinned", Modifier.padding(start = 12.dp, bottom = 4.dp), style = Dray.Font.footnote.copy(color = Dray.secondary))
                for (k in pinned) TaskRow(server, k) { dismiss(); open(k) }
            }
            runs.forEachIndexed { i, run ->
                if (i > 0 || pinned.isNotEmpty()) Spacer(Modifier.height(16.dp))
                for (k in run) TaskRow(server, k) { dismiss(); open(k) }
            }
        }
    }
}

@Composable
private fun TaskRow(server: String, key: SessionKey, onClick: () -> Unit) {
    val store = LocalStore.current
    val item = store.items[key] ?: return
    val asking = store.isAsking(key)
    val pr = store.prMark(key, item)
    Row(
        Modifier.fillMaxWidth().height(48.dp).alpha(if (item.aside == true) 0.3f else 1f).clip(RoundedCornerShape(Dray.Radius.md))
            .clickable(onClick = onClick).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) {
            when {
                item.busy && !asking -> Orb(OrbKind.Working)
                store.inBackground(key) && !asking -> Orb(OrbKind.Background)
                else -> BotFace(key.id, size = 22.dp)
            }
        }
        Text(
            item.title.ifEmpty { "Untitled" }, Modifier.weight(1f),
            style = Dray.Font.body.copy(color = if (asking) Dray.accent else Dray.text), maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        // Asked of the bot's server, not `key`: a machine paired directly and shared too can hand the shared copy of a task that runs right here.
        if (store.items[SessionKey(server, key.id)] == null) Icon(Icons.Outlined.Dns, "Runs on ${store.name(key.server)}", Modifier.size(12.dp), tint = Dray.secondary)
        pr?.let {
            if (it.state == "OPEN" && it.checksState == "RUNNING") ChecksSpinner(14.dp) else PrGlyph(it, 14.dp)
            Text("#${it.number}", style = Dray.Font.footnote.copy(color = Dray.secondary))
        }
    }
}

/** Whether the server the bot lives on is up, for screens that act on it. */
fun com.yogesh.dray.store.Store.up(server: String) = serverState[server] == ConnState.Connected
