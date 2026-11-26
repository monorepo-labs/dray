package com.yogesh.dray.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SubdirectoryArrowRight
import androidx.compose.material.icons.filled.Error
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.Item
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.ToolCall
import com.yogesh.dray.model.ToolState
import com.yogesh.dray.model.Turn
import com.yogesh.dray.model.TurnPrompt
import com.yogesh.dray.model.editCounts
import com.yogesh.dray.model.foldedImages
import com.yogesh.dray.model.groupLabel
import com.yogesh.dray.model.groupVerb
import com.yogesh.dray.model.isRoutineError
import com.yogesh.dray.model.isWholeFileRead
import com.yogesh.dray.model.mcpSummary
import com.yogesh.dray.model.summaryLabel
import com.yogesh.dray.model.toolLabel
import com.yogesh.dray.wire.ImageRef
import androidx.compose.runtime.staticCompositionLocalOf

/** The session a tool row's whole body is read from. */
val LocalCallSession = staticCompositionLocalOf<SessionKey?> { null }

/** How many of a running turn's newest rows stay on screen: the rest fold behind a summary. */
private const val LIVE_ROWS = 5

/**
 * One turn as the desktop draws it: the prompt, then its work — folded to a summary line once
 * finished and long, the newest five rows while it runs — then the answer.
 */
@Composable
fun TurnView(turn: Turn) {
    // Per segment index, so a fold opened mid-turn stays open as the turn finishes.
    val open = remember(turn.id) { mutableStateMapOf<Int, Boolean>() }
    Column(Modifier.fillMaxWidth().animateContentSize(tween(280)), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        turn.prompt?.let { UserBubble(it) }
        val collapsible = turn.completed && turn.rows >= 3
        val segments = turn.segments
        var finalShown = turn.finalLifted
        if (collapsible || turn.running) {
            segments.forEachIndexed { i, seg ->
                val isOpen = open[i] == true
                if (turn.running && i == segments.lastIndex) {
                    LiveWork(seg.items, isOpen) { open[i] = !isOpen }
                } else {
                    if (seg.items.isNotEmpty()) {
                        SummaryToggle(summaryLabel(seg.items), isOpen) { open[i] = !isOpen }
                        if (!isOpen) Thumbnails(foldedImages(seg.items))
                        AnimatedVisibility(isOpen, enter = fadeIn(), exit = fadeOut()) {
                            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) { seg.items.forEach { ItemRow(it) } }
                        }
                    }
                    // A finished long turn's answer shows while the stretch holding it is shut.
                    if (!turn.finalLifted && collapsible && i == segments.lastIndex && !isOpen) finalShown = true
                }
                seg.prompt?.let { UserBubble(TurnPrompt(it.text, it.from, it.images), queued = false) }
            }
        } else {
            turn.work.forEach { ItemRow(it) }
        }
        if (finalShown) turn.finalText?.let { MarkdownText(it) }
        turn.failure?.let { FailureRow(it) }
    }
}

/** A running turn's newest rows, the older ones behind a summary until opened. */
@Composable
private fun LiveWork(items: List<Item>, open: Boolean, toggle: () -> Unit) {
    val hidden = if (items.size > LIVE_ROWS) items.dropLast(LIVE_ROWS) else emptyList()
    if (hidden.isNotEmpty()) SummaryToggle(summaryLabel(hidden), open, toggle)
    val shown = if (open) items else items.takeLast(LIVE_ROWS)
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) { shown.forEach { ItemRow(it) } }
}

@Composable
fun ItemRow(item: Item) {
    when (item) {
        is Item.Text -> MarkdownText(item.text)
        is Item.Tool -> ToolRow(item.call)
        is Item.Group -> GroupRow(item)
        is Item.Prompt -> UserBubble(TurnPrompt(item.text, item.from, item.images))
        is Item.Failure -> FailureRow(item.text)
    }
}

@Composable
fun SummaryToggle(label: String, open: Boolean, toggle: () -> Unit) {
    Row(
        Modifier.clickable(remember { MutableInteractionSource() }, null, onClick = toggle).padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = Dray.Font.subhead.copy(color = Dray.tertiary))
        Chevron(open)
    }
}

@Composable
fun FailureRow(text: String) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.md)).background(Dray.destructive.copy(alpha = 0.1f)).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Filled.Error, null, Modifier.padding(top = 2.dp).width(16.dp), tint = Dray.destructive)
        Text(text, style = Dray.Font.subhead.copy(color = Dray.destructive))
    }
}

/** The reader's own words: right-aligned in the sent blue. A relayed one names its sender above. */
@Composable
fun UserBubble(prompt: TurnPrompt, queued: Boolean = false) {
    Column(
        Modifier.fillMaxWidth().padding(start = 48.dp).alpha(if (queued) 0.55f else 1f),
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        prompt.from?.let {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(Icons.Filled.SubdirectoryArrowRight, null, Modifier.width(13.dp), tint = Dray.tertiary)
                Text("From $it", style = Dray.Font.footnote.copy(color = Dray.tertiary))
            }
        }
        Thumbnails(prompt.images, end = true)
        if (prompt.text.isNotBlank()) {
            ClampedText(
                prompt.text,
                Dray.Font.body.copy(color = Dray.onSent),
                Modifier.clip(RoundedCornerShape(Dray.Radius.xl)).background(Dray.sent).padding(horizontal = 14.dp, vertical = 10.dp),
            )
        }
        if (queued) Text("Queued", style = Dray.Font.footnote.copy(color = Dray.tertiary))
    }
}

/** `+N -M`, an edit's line counts. */
@Composable
private fun ChangeCount(added: Int, removed: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (added > 0) Text("+$added", style = Dray.Font.subhead.copy(color = Dray.add, fontFamily = FontFamily.Monospace))
        if (removed > 0) Text("-$removed", style = Dray.Font.subhead.copy(color = Dray.destructive, fontFamily = FontFamily.Monospace))
    }
}

/**
 * One call: its verb and what it acted on, opening onto its output. A row a `lite` read cut
 * reads its call whole before drawing a body, so a fragment never shows.
 */
@Composable
fun ToolRow(call: ToolCall, showLabel: Boolean = true) {
    val store = LocalStore.current
    val session = LocalCallSession.current
    var open by rememberSaveable(call.id) { mutableStateOf(false) }
    val pending = call.state == ToolState.Pending
    val alarming = call.state == ToolState.Failed && !isRoutineError(call.output)
    val expandable = !call.output.isNullOrEmpty() && (call.state == ToolState.Failed || !isWholeFileRead(call))
    val summary = if (call.name.startsWith("mcp__")) mcpSummary(call.name) ?: call.summary else call.summary
    val counts = editCounts(call)
    if (call.cut && session != null && call.callId != null && (open || call.toolType == "file_edit")) {
        LaunchedEffect(call.id, open) { store.completeCall(session, call.callId) }
    }
    val openRun = LocalOpenRun.current
    val spawn = call.toolType == "subagent_spawn" && call.callId != null && openRun != null
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable(remember { MutableInteractionSource() }, null, enabled = expandable || spawn) {
                // A subagent's row opens what it is doing, as the desktop's opens its panel.
                if (spawn && openRun?.invoke(call.callId!!) == true) return@clickable
                if (expandable) open = !open
            },
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (pending && call.toolType == "subagent_spawn") Orb(OrbKind.Delegating)
            if (showLabel || summary == null || alarming) {
                Text(
                    toolLabel(call.name, pending),
                    style = Dray.Font.subhead.copy(color = if (alarming) Dray.destructive else Dray.secondary),
                    modifier = if (pending) Modifier.shimmer() else Modifier,
                )
            }
            summary?.let {
                Text(it.lineSequence().first(), Modifier.weight(1f, fill = false), style = Dray.Font.subhead.copy(color = Dray.tertiary),
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            counts?.let { ChangeCount(it.first, it.second) }
            if (expandable) Chevron(open)
        }
        for (ref in call.images) InlineImage(ref)
        AnimatedVisibility(open, enter = fadeIn(), exit = fadeOut()) {
            when {
                call.cut && session != null && store.callFailed(session, call.callId ?: "") -> CallFailed { store.completeCall(session, call.callId ?: "") }
                call.cut -> {}
                else -> OutputWell(call.output.orEmpty())
            }
        }
    }
}

@Composable
private fun OutputWell(output: String) {
    val text = if (output.length > 6000) output.take(6000) + "\n…" else output
    Box(Modifier.fillMaxWidth().well()) {
        Text(
            text,
            Modifier.horizontalScroll(rememberScrollState()).padding(12.dp),
            style = Dray.Font.footnote.copy(color = Dray.secondary, fontFamily = FontFamily.Monospace),
            softWrap = false,
        )
    }
}

@Composable
private fun CallFailed(retry: () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Couldn't load this.", style = Dray.Font.footnote.copy(color = Dray.secondary))
        Text("Retry", Modifier.clickable(onClick = retry), style = Dray.Font.footnote)
    }
}

/** Consecutive calls to one tool behind one row: "Read 3 files", opening onto each. */
@Composable
fun GroupRow(group: Item.Group) {
    val store = LocalStore.current
    val session = LocalCallSession.current
    var open by rememberSaveable(group.id) { mutableStateOf(false) }
    val pending = group.calls.any { it.state == ToolState.Pending }
    val anyCut = group.calls.any { it.toolType == "file_edit" && it.cut }
    if (anyCut && session != null) {
        LaunchedEffect(group.calls.size) {
            group.calls.filter { it.toolType == "file_edit" && it.cut }.forEach { c -> c.callId?.let { store.completeCall(session, it) } }
        }
    }
    val counts = if (anyCut) null else group.calls.mapNotNull { editCounts(it) }.takeIf { it.isNotEmpty() }
        ?.fold(0 to 0) { a, b -> (a.first + b.first) to (a.second + b.second) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable(remember { MutableInteractionSource() }, null) { open = !open },
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val label = if (group.target != null) groupVerb(group.name, pending) else groupLabel(group.name, group.targets, pending)
            Text(label, style = Dray.Font.subhead.copy(color = Dray.secondary), modifier = if (pending) Modifier.shimmer() else Modifier)
            group.target?.let {
                Text(it.lineSequence().first(), Modifier.weight(1f, fill = false), style = Dray.Font.subhead.copy(color = Dray.tertiary),
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (group.calls.size > group.targets) Text("${group.calls.size} calls", style = Dray.Font.subhead.copy(color = Dray.tertiary))
            counts?.let { ChangeCount(it.first, it.second) }
            Chevron(open)
        }
        AnimatedVisibility(open, enter = fadeIn(), exit = fadeOut()) {
            Column(
                Modifier
                    .drawBehind { drawRect(Dray.border, Offset.Zero, size.copy(width = 1.dp.toPx())) }
                    .padding(start = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) { group.calls.forEach { ToolRow(it, showLabel = false) } }
        }
    }
}

/** The orb and a word while a turn runs: one word, fixed for the wait. */
@Composable
fun WorkingLine() {
    val word = remember { listOf("Working", "Cooking", "Brewing", "Thinking").random() }
    OrbLine(OrbKind.Working, word)
}

@Composable
fun OrbLine(kind: OrbKind, label: String, modifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Orb(kind)
        Text(label, Modifier.shimmer(), style = Dray.Font.subhead.copy(color = Dray.secondary), maxLines = 1)
    }
}

/** What a turn's pictures page through when one is tapped: the gallery of the turn it sits in. */
fun shotsOf(turns: List<Turn>, ref: ImageRef) = turns.firstOrNull { t -> t.gallery.any { it.ref == ref } }?.gallery

@Composable
fun Gap(h: androidx.compose.ui.unit.Dp) = Spacer(Modifier.height(h))

@Composable
fun MaxWidth(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.widthIn(max = 760.dp).fillMaxWidth()) { content() }
    }
}
