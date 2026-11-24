package com.yogesh.dray.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.BotItem
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.store.approveIssue
import com.yogesh.dray.wire.IssueCardRow
import com.yogesh.dray.wire.IssueLabel
import kotlinx.coroutines.launch

// The desktop's chat/IssueCard.tsx, restated for a bot's chat.

/** GitHub's dark-mode closed purple; its light one is too deep to read on this card. */
private val closedPurple = Color(0xFFA371F7)

/** A tile's own fill: the desktop's `--muted` at 55% over the card. */
private val tileFill = Dray.raised.copy(alpha = 0.55f)

/**
 * GitHub issues a bot posted with `dray session issue-card`, each on a tile of its own, on the
 * merge card's surface. A tap opens the issue on GitHub, there being no issue view here; an open
 * issue's play button hands it to the agent. `settled`: the chat has no agent left to tell.
 */
@Composable
fun IssueCardView(server: String, item: BotItem.Issues, settled: Boolean) {
    val uri = LocalUriHandler.current
    val shape = RoundedCornerShape(Dray.Radius.group)
    // One width for every action slot on the card, so the titles end in one column.
    val slot = if (item.started.isNotEmpty()) 92.dp else 48.dp
    Column(
        Modifier.fillMaxWidth().clip(shape).background(Dray.card).border(1.dp, Dray.hairline, shape).padding(4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(
            Modifier.padding(start = 10.dp, end = 10.dp, top = 6.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            GitHubMark(12.dp, Dray.secondary)
            Text(item.card.repo, style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        for (row in item.card.issues) IssueTile(
            row, slot,
            open = { runCatching { uri.openUri(row.url) } },
        ) {
            when {
                row.number in item.started -> Started()
                row.closed || settled -> {}
                else -> WorkOn(SessionKey(server, item.sessionId), item.id, row.number)
            }
        }
    }
}

@Composable
private fun IssueTile(row: IssueCardRow, slot: Dp, open: () -> Unit, action: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(Dray.Radius.lg)).background(tileFill),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.weight(1f).heightIn(min = 48.dp).clickable(onClick = open).padding(start = 12.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "#${row.number}",
                Modifier.semantics { contentDescription = "#${row.number}, ${if (row.closed) "closed" else "open"}" },
                style = Dray.Font.subhead.copy(color = if (row.closed) closedPurple else Dray.secondary),
            )
            Text(
                row.title, Modifier.weight(1f),
                style = Dray.Font.subhead.copy(color = if (row.closed) Dray.secondary else Dray.text),
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            LabelDots(row.labels)
        }
        Box(Modifier.width(slot), contentAlignment = Alignment.CenterEnd) { action() }
    }
}

/** A label's colour alone, the name being GitHub's to show; four at most. */
@Composable
private fun LabelDots(labels: List<IssueLabel>) {
    if (labels.isEmpty()) return
    Row(
        Modifier.semantics { contentDescription = labels.joinToString(", ") { it.name } },
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        for (label in labels.take(4)) Box(Modifier.size(8.dp).clip(CircleShape).background(hexColor(label.color) ?: Dray.secondary))
    }
}

private fun hexColor(hex: String): Color? =
    hex.removePrefix("#").takeIf { it.length == 6 }?.toLongOrNull(16)?.let { Color(0xFF000000 or it) }

@Composable
private fun Started() {
    Row(
        Modifier.padding(end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(Icons.Filled.Check, null, Modifier.size(15.dp), tint = Dray.add)
        Text("Started", style = Dray.Font.footnote.copy(color = Dray.secondary))
    }
}

/** The play button: hands the issue to the agent. A failure tints it red and says why in the toast. */
@Composable
private fun WorkOn(chat: SessionKey, cardId: String, number: Int) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    var sending by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    IconButton(
        onClick = {
            sending = true
            failed = false
            scope.launch {
                // Started takes over from the logged hand-off, which lands before the call answers.
                store.approveIssue(chat, cardId, number)?.let {
                    failed = true
                    store.lastError = "Couldn't start #$number: $it"
                }
                sending = false
            }
        },
        enabled = !sending,
    ) {
        if (sending) CircularProgressIndicator(Modifier.size(16.dp), color = Dray.secondary, strokeWidth = 2.dp)
        else Icon(Icons.Filled.PlayArrow, "Work on it", Modifier.size(20.dp), tint = if (failed) Dray.destructive else Dray.secondary)
    }
}

private val githubPath = PathParser().parsePathString(
    "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z",
).toPath().apply { fillType = PathFillType.EvenOdd }

/** GitHub's mark, the desktop's `GitHubIcon`, in one ink. */
@Composable
fun GitHubMark(size: Dp, tint: Color) {
    Canvas(Modifier.size(size)) { scale(this.size.width / 16f, pivot = Offset.Zero) { drawPath(githubPath, tint) } }
}
