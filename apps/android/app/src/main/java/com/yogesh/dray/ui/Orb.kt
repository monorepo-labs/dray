package com.yogesh.dray.ui

import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

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

/** The orb for an activity, in the page's ink, at the package's tuned 20dp unless asked. The iOS app's `Orb(activity)`. */
@Composable
fun Orb(kind: OrbKind, size: Dp = 20.dp, modifier: Modifier = Modifier, label: String? = null) {
    when (kind) {
        OrbKind.Working -> ThinkingOrb(OrbState.Working, size = size, modifier = modifier, label = label)
        OrbKind.Delegating -> ThinkingOrb(OrbState.Working, OrbVariant.Gyro, size, modifier = modifier, label = label)
        OrbKind.Background -> ThinkingOrb(OrbState.Background, OrbVariant.Spiral, size, modifier = modifier, label = label)
        OrbKind.Reconnecting -> ThinkingOrb(OrbState.Searching, OrbVariant.Lighthouse, size, speed = 3.0, modifier = modifier, label = label)
        OrbKind.Loading -> ThinkingOrb(OrbState.Searching, size = size, modifier = modifier, label = label)
    }
}

/**
 * The Thinking Orbs package's `Orb`: a sphere of dots in the page's ink, every look tuned to read at
 * 20dp. One frame clock drives it, read in the draw phase alone, so a turning orb never recomposes its
 * row. With animations off in the system's settings it holds still, as iOS does under Reduce Motion.
 */
@Composable
fun ThinkingOrb(
    state: OrbState = OrbState.Idle,
    variant: OrbVariant = OrbVariant.Default,
    size: Dp = 20.dp,
    speed: Double = 1.0,
    paused: Boolean = false,
    tint: Color = Dray.text,
    modifier: Modifier = Modifier,
    label: String? = null,
) {
    val config = OrbConfig(Look.of(state, variant), size.value.toDouble())
    val engine = remember(config) { OrbEngine(config) }
    val context = LocalContext.current
    val still = remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    var now by remember { mutableLongStateOf(0L) }
    LaunchedEffect(paused, still) {
        if (paused || still) return@LaunchedEffect
        while (true) withFrameMillis { now = it }
    }
    val clock = "${config.look.key}@$speed"
    Canvas(modifier.size(size).then(if (label != null) Modifier.semantics { contentDescription = label } else Modifier)) {
        val t = if (still) 0.0 else tick(clock, now.toDouble(), speed)
        val k = this.size.width / config.size.toFloat()
        engine.draw(t) { x, y, r, a ->
            // Opacity to two places like the web's; no dot drops below 0.45pt, or it renders as a grey haze.
            val o = min(100, (a * 100).roundToInt())
            if (o > 0) drawCircle(tint, (max(0.45, r) * k).toFloat(), Offset((x * k).toFloat(), (y * k).toFloat()), alpha = o / 100f)
        }
    }
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
