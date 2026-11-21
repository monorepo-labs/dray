package com.yogesh.dray.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Lucide's check-check, the settled view's mark, on a 24-unit grid. */
@Composable
fun CheckCheck(color: Color, size: Dp = 18.dp, width: Float = 1.35f) {
    Canvas(Modifier.size(size)) {
        val s = this.size.width / 24f
        fun line(vararg pts: Pair<Float, Float>) = Path().apply {
            moveTo(pts[0].first * s, pts[0].second * s)
            for (p in pts.drop(1)) lineTo(p.first * s, p.second * s)
        }
        val stroke = Stroke(width.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawPath(line(2f to 12.5f, 6.5f to 17f, 15f to 8.5f), color, style = stroke)
        drawPath(line(13f to 16f, 14f to 17f, 22.5f to 8.5f), color, style = stroke)
    }
}

/** The empty list's art once today's work is settled: the newest settled row, with two slivers stacked under it. */
@Composable
fun SettledStack(title: String, time: String) {
    Column(Modifier.widthIn(max = 300.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.card).padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            CheckCheck(Dray.add)
            Text(title.ifEmpty { "Untitled" }, Modifier.weight(1f), style = Dray.Font.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(time, style = Dray.Font.footnote.copy(color = Dray.tertiary))
        }
        Sliver(Color(0xFF141414), 7.dp, 0.92f, 10.dp)
        Sliver(Color(0xFF101010), 6.dp, 0.84f, 9.dp)
    }
}

@Composable
private fun Sliver(fill: Color, height: Dp, width: Float, radius: Dp) {
    Box(Modifier.fillMaxWidth(width).height(height).clip(RoundedCornerShape(bottomStart = radius, bottomEnd = radius)).background(fill))
}
