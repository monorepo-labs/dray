package com.yogesh.dray.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer

/** A light sweeping across live text, as the desktop's working rows shimmer. */
fun Modifier.shimmer(): Modifier = composed {
    val t = rememberInfiniteTransition(label = "shimmer")
    val x by t.animateFloat(-0.5f, 1.5f, infiniteRepeatable(tween(1600, easing = LinearEasing)), label = "x")
    graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
        .drawWithContent {
            drawContent()
            val w = size.width
            drawRect(
                Brush.linearGradient(
                    listOf(Color.White.copy(alpha = 0.45f), Color.White, Color.White.copy(alpha = 0.45f)),
                    start = Offset(w * (x - 0.3f), 0f), end = Offset(w * (x + 0.3f), 0f),
                ),
                blendMode = BlendMode.DstIn,
            )
        }
}
