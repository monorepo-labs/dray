package com.yogesh.dray.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * The one place app states map to an orb: working, delegating, background, reconnecting,
 * loading. The iOS app draws these with its Thinking Orbs package; this is a light stand-in
 * in the same spirit — dots on an orbit, each state its own motion.
 */
enum class OrbKind { Working, Delegating, Background, Reconnecting, Loading }

@Composable
fun Orb(kind: OrbKind, size: Dp = 16.dp, modifier: Modifier = Modifier) {
    val t = rememberInfiniteTransition(label = "orb")
    val period = when (kind) {
        OrbKind.Reconnecting -> 700
        OrbKind.Delegating -> 1600
        OrbKind.Background -> 2400
        else -> 1200
    }
    val phase by t.animateFloat(0f, 1f, infiniteRepeatable(tween(period, easing = LinearEasing)), label = "phase")
    val pulse by t.animateFloat(0.55f, 1f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "pulse")
    Canvas(modifier.size(size)) {
        val r = this.size.minDimension / 2
        val c = center
        when (kind) {
            OrbKind.Working, OrbKind.Loading -> {
                val n = 3
                for (i in 0 until n) {
                    val a = 2 * PI * (phase + i.toFloat() / n)
                    val p = Offset(c.x + (r * 0.55f) * cos(a).toFloat(), c.y + (r * 0.55f) * sin(a).toFloat())
                    drawCircle(Dray.text.copy(alpha = 0.35f + 0.65f * ((i + 1f) / n) * pulse), r * 0.22f, p)
                }
            }
            OrbKind.Delegating -> {
                rotate(phase * 360f) {
                    drawOval(Dray.text.copy(alpha = 0.8f), topLeft = Offset(c.x - r * 0.85f, c.y - r * 0.35f),
                        size = androidx.compose.ui.geometry.Size(r * 1.7f, r * 0.7f), style = Stroke(r * 0.14f))
                }
                rotate(-phase * 360f + 60f) {
                    drawOval(Dray.secondary.copy(alpha = 0.7f), topLeft = Offset(c.x - r * 0.85f, c.y - r * 0.35f),
                        size = androidx.compose.ui.geometry.Size(r * 1.7f, r * 0.7f), style = Stroke(r * 0.14f))
                }
                drawCircle(Dray.text, r * 0.18f, c)
            }
            OrbKind.Background -> {
                for (i in 0 until 6) {
                    val f = i / 6f
                    val a = 2 * PI * (phase - f * 0.5)
                    val rr = r * (0.25f + 0.6f * f)
                    drawCircle(Dray.secondary.copy(alpha = 1f - f * 0.8f), r * 0.14f,
                        Offset(c.x + rr * cos(a).toFloat(), c.y + rr * sin(a).toFloat()))
                }
            }
            OrbKind.Reconnecting -> {
                drawCircle(Dray.text.copy(alpha = 0.25f), r * 0.85f, c, style = Stroke(r * 0.14f))
                drawArc(Dray.text, phase * 360f, 70f, false, topLeft = Offset(c.x - r * 0.85f, c.y - r * 0.85f),
                    size = androidx.compose.ui.geometry.Size(r * 1.7f, r * 1.7f), style = Stroke(r * 0.18f))
            }
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
