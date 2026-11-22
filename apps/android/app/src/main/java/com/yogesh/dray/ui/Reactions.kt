package com.yogesh.dray.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.yogesh.dray.model.SessionKey
import kotlin.math.ceil

/** The reactions there are, the bot's and the reader's alike: `EMOJI` in react.rs, which refuses any other. */
val reactions = listOf("👍", "❤️", "😂", "🎉", "✅", "👀", "😢")

private val reactionLabels = mapOf("👀" to "Seen", "✅" to "Done", "🎉" to "Celebrating", "👍" to "Like", "❤️" to "Love", "😂" to "Laughing", "😢" to "Sad")

/** A reaction's emoji as its badge draws it. */
val reactionStyle = Dray.Font.body.copy(fontSize = 18.sp, lineHeight = 20.sp)

/**
 * A reaction, as a messenger draws one: a round chip in the chat's own colour, a hairline edge and
 * a ring of that colour again outside it, so it reads as cut out of the bubble under it; the emoji
 * at about half its height and centred upright by its ink ([inkOf]), not by its text box.
 */
@Composable
fun ReactionBadge(emoji: String, mine: Boolean = false) {
    var nudge by remember(emoji) { mutableStateOf(0f) }
    Box(
        // The ring is drawn before the clip, so it spills past the badge without moving it.
        Modifier.size(40.dp).drawBehind { drawCircle(Dray.page, radius = size.minDimension / 2 + 3.dp.toPx()) }
            .clip(CircleShape).background(Dray.page).border(1.dp, Dray.border, CircleShape)
            .semantics { contentDescription = "${if (mine) "You" else "Bot"} reacted: ${reactionLabels[emoji] ?: emoji}" },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            emoji,
            Modifier.graphicsLayer { translationY = nudge },
            style = reactionStyle,
            onTextLayout = { layout -> nudge = centring(emoji, layout) },
        )
    }
}

/**
 * How far below its ink's centre `emoji` must sit to look centred, in ems: the desktop's
 * `opticalDrop`, judged on Apple's font. Centred exactly, every emoji read half a pixel low at
 * 18px; the heart's point leaves the middle of its box above its mass, so it sinks a pixel past.
 */
private fun opticalDrop(emoji: String) = if (emoji == "❤️") 0.028f else -0.028f

/**
 * How far down to move `emoji`'s laid-out text so its ink sits at the box's middle, by eye.
 * Vertical alone: an emoji is lopsided sideways by design, and centring that ink read as a shift.
 */
fun centring(emoji: String, layout: TextLayoutResult): Float {
    val px = with(layout.layoutInput.density) { layout.layoutInput.style.fontSize.toPx() }
    val ink = inkOf(emoji, px) ?: return 0f
    return layout.size.height / 2f - (layout.firstBaseline + (ink.top + ink.bottom) / 2f) + opticalDrop(emoji) * px
}

private val measured = HashMap<Pair<String, Float>, RectF?>()

/**
 * `emoji`'s ink at `px`, relative to where it starts on its baseline. Every emoji font places
 * each glyph at its own spot in the em box (Google's, Samsung's), so a fixed nudge per emoji is
 * right on some phones alone; the default typeface is the one Compose draws emoji in here.
 */
private fun inkOf(emoji: String, px: Float): RectF? = measured.getOrPut(emoji to px) {
    val size = ceil(px).toInt()
    val side = size * 4
    val bitmap = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
    // Origin a size in from the left and three down, so overhang either way is kept.
    Canvas(bitmap).drawText(emoji, size.toFloat(), size * 3f, Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = px; typeface = Typeface.DEFAULT })
    val pixels = IntArray(side * side).also { bitmap.getPixels(it, 0, side, 0, 0, side, side) }
    bitmap.recycle()
    var left = side; var top = side; var right = 0; var bottom = 0
    for (y in 0 until side) for (x in 0 until side) {
        // Alpha at or under this is anti-aliasing haze, not ink.
        if ((pixels[y * side + x] ushr 24) <= 24) continue
        if (x < left) left = x
        if (x >= right) right = x + 1
        if (y < top) top = y
        if (y >= bottom) bottom = y + 1
    }
    if (right <= left) null
    else RectF(left - size.toFloat(), top - size * 3f, right - size.toFloat(), bottom - size * 3f)
}

/**
 * A bot's message, which a long press reacts to, as a messenger does: the set opens over it, and
 * nothing else with it, a reaction and a copy being two different things. `content` takes the
 * press on the modifier it is handed. Nothing reacts where `key` is null or the chat is settled.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Reactable(key: SessionKey?, messageId: String, current: String?, content: @Composable (Modifier) -> Unit) {
    val store = LocalStore.current
    val haptic = LocalHapticFeedback.current
    var picking by remember { mutableStateOf(false) }
    val open = key != null && store.items[key]?.archived != true
    val press = if (!open) Modifier else Modifier.combinedClickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = null,
        onLongClickLabel = "React",
        onLongClick = { haptic.performHapticFeedback(HapticFeedbackType.LongPress); picking = true },
        onClick = {},
    )
    Box {
        // Its own words opt out of the chat's selection, or the same press starts one under the set.
        if (open) DisableSelection { content(press) } else content(press)
        // Out of the chat's SelectionContainer: its text lives in the popup's own window, and
        // selection measuring across the two throws "layouts are not part of the same hierarchy".
        if (picking && key != null) Popup(OverOrUnder, onDismissRequest = { picking = false }, properties = PopupProperties(focusable = true)) {
            val shape = RoundedCornerShape(percent = 50)
            DisableSelection { Row(
                Modifier.shadow(12.dp, shape).clip(shape).background(Dray.raised).border(0.5.dp, Color.White.copy(alpha = 0.14f), shape)
                    .padding(horizontal = 6.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                for (emoji in reactions) Box(
                    Modifier.size(42.dp).clip(CircleShape).background(if (emoji == current) Dray.tile else Color.Transparent)
                        .clickable(onClickLabel = reactionLabels[emoji]) {
                            if (emoji != current) store.react(key, messageId, emoji)
                            picking = false
                        },
                    contentAlignment = Alignment.Center,
                ) { Text(emoji, style = Dray.Font.body.copy(fontSize = 24.sp, lineHeight = 28.sp)) }
            } }
        }
    }
}

/** Above the message where there is room, else under it, and never off the window. */
private object OverOrUnder : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val gap = 24
        val x = anchorBounds.left.coerceIn(0, maxOf(0, windowSize.width - popupContentSize.width))
        val above = anchorBounds.top - popupContentSize.height - gap
        val y = if (above >= 0) above else anchorBounds.bottom + gap
        return IntOffset(x, y.coerceIn(0, maxOf(0, windowSize.height - popupContentSize.height)))
    }
}
