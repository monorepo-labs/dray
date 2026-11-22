package com.yogesh.dray.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.Blobatar
import com.yogesh.dray.wire.Bot
import com.yogesh.dray.wire.BotAvatar
import com.yogesh.dray.wire.face

private class FacePart(val color: Color, val path: Path)

/** Faces by seed and pick: a list's worth are drawn on every redraw, and building one is the costly part. */
private val faces = object : LinkedHashMap<String, List<FacePart>>(64, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, List<FacePart>>?) = size > 300
}

private fun facePaths(seed: String, avatar: BotAvatar?): List<FacePart> {
    val key = "$seed|${avatar?.shape}|${avatar?.hue}"
    faces[key]?.let { return it }
    val parts = Blobatar.face(seed, avatar).map { p ->
        val color = Color(android.graphics.Color.parseColor(p.fill))
        when (p) {
            is Blobatar.Part.Circle -> FacePart(color, Path().apply {
                addOval(androidx.compose.ui.geometry.Rect(Offset(p.cx.toFloat(), p.cy.toFloat()), p.r.toFloat()))
            })
            is Blobatar.Part.Shape -> FacePart(color, PathParser().parsePathString(p.d).toPath())
        }
    }
    faces[key] = parts
    return parts
}

/**
 * A bot's face, or a bot task's, drawn by the app's own code: iOS's `BotFace`. A task wears a
 * face seeded from its session id, as the desktop's `seededAvatar`.
 */
@Composable
fun BotFace(seed: String, avatar: BotAvatar? = null, size: Dp = 20.dp, modifier: Modifier = Modifier) {
    val parts = remember(seed, avatar) { facePaths(seed, avatar) }
    Canvas(modifier.size(size)) {
        // The sidebar's scale: the shape sits inside its box with room to spare.
        val k = this.size.width / 100f * 1.18f
        translate(this.size.width / 2 - 50 * k, this.size.height / 2 - 50 * k) {
            scale(k, k, pivot = Offset.Zero) {
                for (p in parts) drawPath(p.path, p.color)
            }
        }
    }
}

@Composable
fun BotFace(bot: Bot, size: Dp = 20.dp, modifier: Modifier = Modifier) = BotFace(bot.id, bot.face, size, modifier)

/** The app's `TypingDots`: what a bot shows while it works, in place of the task orb. */
@Composable
fun TypingDots(modifier: Modifier = Modifier) {
    val t = rememberInfiniteTransition(label = "typing")
    val clock by t.animateFloat(0f, 1.2f, infiniteRepeatable(tween(1200, easing = LinearEasing)), label = "clock")
    Row(modifier.semantics { contentDescription = "Working" }, horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        for (i in 0 until 3) {
            val k = lift(clock - i * 0.16f)
            Box(
                Modifier.offset(y = (-2 * k).dp).size(4.dp).alpha(0.35f + 0.65f * k).clip(CircleShape).background(Color.White.copy(alpha = 0.5f)),
            )
        }
    }
}

/** The CSS `typing-dot` keyframes: up at 30% of a 1.2s cycle, back at 60%, rest after. */
private fun lift(t: Float): Float {
    val p = ((t % 1.2f) + 1.2f) % 1.2f / 1.2f
    val k = if (p < 0.3f) p / 0.3f else if (p < 0.6f) (0.6f - p) / 0.3f else 0f
    return k * k * (3 - 2 * k)
}
