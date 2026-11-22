package com.yogesh.dray.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.yogesharc.thinkingorbs.OrbState
import com.yogesharc.thinkingorbs.OrbVariant
import com.yogesharc.thinkingorbs.Orb as ThinkingOrb

/**
 * What the app is waiting on wherever an orb is drawn. Each maps to the orb the desktop draws for
 * the same wait, the iOS app's `Activity`.
 */
enum class OrbKind {
    /** A turn running: the row's slot, the transcript's working line. */
    Working,
    /** A subagent or delegated run. */
    Delegating,
    /** Background tasks outliving the turn. */
    Background,
    /** A server being reached again. */
    Reconnecting,
    /** Reading something in: a transcript, a list. No desktop twin; searching is the nearest. */
    Loading,
}

/** The Thinking Orbs look a kind draws as. */
internal data class OrbLook(val state: OrbState, val variant: OrbVariant = OrbVariant.Default, val speed: Double = 1.0)

internal val OrbKind.look: OrbLook
    get() = when (this) {
        OrbKind.Working -> OrbLook(OrbState.Working)
        OrbKind.Delegating -> OrbLook(OrbState.Working, OrbVariant.Gyro)
        OrbKind.Background -> OrbLook(OrbState.Background, OrbVariant.Spiral)
        OrbKind.Reconnecting -> OrbLook(OrbState.Searching, OrbVariant.Lighthouse, speed = 3.0)
        OrbKind.Loading -> OrbLook(OrbState.Searching)
    }

/**
 * The orb for an activity, at the library's tuned 20dp unless asked. The iOS app's `Orb(activity)`.
 * Drawn in the page's ink: the library defaults to the content color, which Dray's pages don't set.
 */
@Composable
fun Orb(kind: OrbKind, size: Dp = 20.dp, modifier: Modifier = Modifier, label: String? = null) {
    val look = kind.look
    ThinkingOrb(look.state, modifier, look.variant, size, color = Dray.text, speed = look.speed, label = label)
}

/** A yellow dashed circle turning once every 3s: a PR whose checks are running. */
@Composable
fun ChecksSpinner(size: Dp = 15.dp) {
    val t = rememberInfiniteTransition(label = "checks")
    val angle by t.animateFloat(0f, 360f, infiniteRepeatable(tween(3000, easing = LinearEasing)), label = "angle")
    Canvas(Modifier.size(size)) {
        val w = 1.5.dp.toPx()
        rotate(angle) {
            drawCircle(Dray.accent, this.size.minDimension / 2 - w, style = Stroke(w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(2.4.dp.toPx(), 3.dp.toPx()))))
        }
    }
}
