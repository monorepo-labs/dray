package com.yogesh.dray.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.yogesh.dray.wire.PrMark
import java.util.concurrent.ConcurrentHashMap

/** A branch's pull request glyph, the desktop's `PrStateIcon`: Lucide's shapes in GitHub's colours, red while checks fail. */
@Composable
fun PrGlyph(mark: PrMark, size: Dp = 15.dp) {
    val merged = mark.state == "MERGED"
    val failing = !merged && mark.checksState == "FAILING"
    val tone = when {
        failing -> Dray.destructive
        merged -> Dray.merged
        mark.isDraft -> Dray.secondary
        else -> Dray.add
    }
    val state = if (merged) "merged" else if (mark.isDraft) "draft" else "open"
    Canvas(Modifier.size(size).semantics { contentDescription = "Pull request #${mark.number}, $state${if (failing) ", checks failing" else ""}" }) {
        val p = Path().apply {
            addOval(Rect(15f, 15f, 21f, 21f))
            addOval(Rect(3f, 3f, 9f, 9f))
            when {
                merged -> {
                    moveTo(6f, 21f); lineTo(6f, 9f)
                    arcTo(Rect(6f, 0f, 24f, 18f), 180f, -90f, false)
                }
                mark.isDraft -> {
                    moveTo(6f, 9f); lineTo(6f, 21f)
                    moveTo(18f, 6f); lineTo(18f, 5f)
                    moveTo(18f, 11f); lineTo(18f, 10f)
                }
                else -> {
                    moveTo(6f, 9f); lineTo(6f, 21f)
                    moveTo(13f, 6f); lineTo(16f, 6f)
                    arcTo(Rect(14f, 6f, 18f, 10f), 270f, 90f, false)
                    lineTo(18f, 15f)
                }
            }
        }
        scale(this.size.width / 24f, pivot = Offset.Zero) {
            drawPath(p, tone, style = Stroke(1.5f, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

private class Svg(val width: Float, val height: Float, val paths: List<Path>)

private val svgs = ConcurrentHashMap<String, Svg>()

/** An agent's mark, read from the same SVG the iOS app ships, drawn in one ink. */
@Composable
fun AgentMark(harness: String, size: Dp = 13.dp, tint: Color = Dray.text) {
    val context = LocalContext.current
    val svg = remember(harness) {
        svgs[harness] ?: runCatching {
            val text = context.assets.open("agents/$harness.svg").bufferedReader().readText()
            val box = Regex("""viewBox="([\d.\s-]+)"""").find(text)?.groupValues?.get(1)?.trim()?.split(Regex("\\s+"))?.map { it.toFloat() }
            val evenOdd = text.contains("evenodd")
            val paths = Regex("""\sd="([^"]+)"""").findAll(text).map {
                PathParser().parsePathString(it.groupValues[1]).toPath().apply { if (evenOdd) fillType = PathFillType.EvenOdd }
            }.toList()
            Svg(box?.getOrNull(2) ?: 24f, box?.getOrNull(3) ?: 24f, paths).also { svgs[harness] = it }
        }.getOrNull()
    } ?: return
    Canvas(Modifier.size(size)) {
        val s = minOf(this.size.width / svg.width, this.size.height / svg.height)
        scale(s, pivot = Offset.Zero) { svg.paths.forEach { drawPath(it, tint) } }
    }
}

/** The disclosure chevron: turned down when open, brighter too. */
@Composable
fun Chevron(open: Boolean, modifier: Modifier = Modifier) {
    val angle by animateFloatAsState(if (open) 90f else 0f, label = "chevron")
    Icon(
        Icons.AutoMirrored.Filled.KeyboardArrowRight, null,
        modifier.size(16.dp).rotate(angle),
        tint = if (open) Dray.secondary else Dray.tertiary,
    )
}
