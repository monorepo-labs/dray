package com.yogesh.dray.ui

import android.os.SystemClock
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** The reversed chat list a [ClampedText] sits in, scrolled to hold the bubble still as it opens. */
val LocalChatList = staticCompositionLocalOf<LazyListState?> { null }

/**
 * Desktop's twenty lines measured about half a phone screen, a third is what twelve take. Still
 * longer than a prompt typed on a phone runs, so only a paste is ever collapsed.
 */
private const val CLAMP_LINES = 12

/**
 * How long the bubble is held after its last move. `TurnView`'s 280ms `animateContentSize` grows
 * the row over several frames, and a slow frame must not let the hold lapse mid-animation.
 */
private const val HOLD_MS = 400L

/**
 * A user bubble's text, stopped at [CLAMP_LINES] with a "Show more" under it, as desktop's
 * `ClampedBody`. Shared by the delivered bubble and the queued one, so a paste is bounded the
 * same way before and after it is sent.
 */
@Composable
fun ClampedText(text: String, style: TextStyle, modifier: Modifier = Modifier) {
    var open by rememberSaveable(text) { mutableStateOf(false) }
    // Read off the layout, not the string: whether the lines hold depends on the bubble's width.
    var clipped by remember(text) { mutableStateOf(false) }
    val list = LocalChatList.current
    val hold = remember { Hold() }
    Column(
        modifier.onGloballyPositioned { c ->
            hold.coords = c
            val top = hold.top ?: return@onGloballyPositioned
            // The reader's own drag wins; so does a hold the animation has long finished with.
            if (list == null || list.isScrollInProgress || SystemClock.uptimeMillis() > hold.until) {
                hold.top = null
                return@onGloballyPositioned
            }
            // The list is reversed, so it anchors on its bottom row and a bubble growing pushes
            // its own top up, off the text the reader just asked to read. Scrolled back by as
            // much on every pass of the turn's height animation, it opens downwards in place.
            val moved = top - c.positionInRoot().y
            if (moved != 0f) {
                list.dispatchRawDelta(moved)
                hold.until = SystemClock.uptimeMillis() + HOLD_MS
            }
        },
    ) {
        Text(
            text,
            style = style,
            maxLines = if (open) Int.MAX_VALUE else CLAMP_LINES,
            overflow = TextOverflow.Ellipsis,
            // Only while collapsed: open, the text is its own full height and never overflows,
            // which would retire the button that collapses it again.
            onTextLayout = { if (!open) clipped = it.hasVisualOverflow },
        )
        if (clipped || open) {
            // Held back by opacity off the bubble's own ink and a size under the body's, so it
            // reads as a control and not as a last line the reader wrote.
            Text(
                if (open) "Show less" else "Show more",
                Modifier.padding(top = 4.dp).clickable(remember { MutableInteractionSource() }, null) {
                    // Opening only. Closing, the reversed list already keeps the bubble's foot
                    // where it was, so the collapsed bubble ends under the finger that tapped.
                    if (!open) {
                        hold.top = hold.coords?.takeIf { it.isAttached }?.positionInRoot()?.y
                        hold.until = SystemClock.uptimeMillis() + HOLD_MS
                    }
                    open = !open
                },
                style = Dray.Font.subhead.copy(color = style.color.copy(alpha = style.color.alpha * 0.7f)),
            )
        }
    }
}

/** Where the bubble's top stood when its toggle was tapped, and how long to keep it there. */
private class Hold {
    var coords: LayoutCoordinates? = null
    var top: Float? = null
    var until = 0L
}
