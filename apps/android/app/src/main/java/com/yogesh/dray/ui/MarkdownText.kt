package com.yogesh.dray.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.yogesh.dray.model.MdBlock
import com.yogesh.dray.model.hiding
import com.yogesh.dray.model.imagePaths
import com.yogesh.dray.model.markdownBlocks
import com.yogesh.dray.model.recordingPaths
import com.yogesh.dray.wire.ImageRef

private val inline = Regex("""`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?!\w)|\[([^\]]+)]\(([^)\s]+)\)|(https?://[^\s<>()]+[^\s<>().,;:!?'"])""")

/** Bold, italics, code spans and links inside one block. */
fun inlineMarkdown(text: String, base: SpanStyle = SpanStyle()): AnnotatedString = buildAnnotatedString {
    var at = 0
    for (m in inline.findAll(text)) {
        append(text.substring(at, m.range.first))
        val g = m.groupValues
        when {
            g[1].isNotEmpty() -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, fontSize = 0.88.em, background = Color.White.copy(alpha = 0.08f))) { append(g[1]) }
            g[2].isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(inlineMarkdown(g[2], base)) }
            g[3].isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(inlineMarkdown(g[3], base)) }
            g[4].isNotEmpty() -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(inlineMarkdown(g[4], base)) }
            g[5].isNotEmpty() -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(inlineMarkdown(g[5], base)) }
            g[6].isNotEmpty() -> withLink(LinkAnnotation.Url(g[7], TextLinkStyles(SpanStyle(color = Dray.link)))) { append(g[6]) }
            else -> withLink(LinkAnnotation.Url(g[8], TextLinkStyles(SpanStyle(color = Dray.link)))) { append(g[8]) }
        }
        at = m.range.last + 1
    }
    append(text.substring(at))
}

/** A message's markdown, block by block, then the recordings and pictures it names by path. */
@Composable
fun MarkdownText(text: String, style: TextStyle = Dray.Font.body, modifier: Modifier = Modifier) {
    val recordings = remember(text) { recordingPaths(text) }
    val images = remember(text) { imagePaths(text) }
    val blocks = remember(text, recordings, images) { markdownBlocks(hiding(recordings + images, text)) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for (block in blocks) Block(block, style)
        for (path in recordings) RecordingPlayer(path)
        for (path in images) InlineImage(ImageRef(path = path), fallback = path)
    }
}

@Composable
private fun Block(block: MdBlock, style: TextStyle) {
    when (block) {
        is MdBlock.Prose -> Text(inlineMarkdown(block.text), style = style)
        is MdBlock.Heading -> Text(
            inlineMarkdown(block.text),
            Modifier.padding(top = 4.dp),
            style = if (block.level <= 2) Dray.Font.title else Dray.Font.headline,
        )
        is MdBlock.Bullets -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (item in block.items) Row(Modifier.padding(start = (item.indent * 18).dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(item.marker, style = style.copy(color = Dray.tertiary))
                Text(inlineMarkdown(item.text), style = style)
            }
        }
        is MdBlock.Quote -> Text(
            inlineMarkdown(block.text),
            Modifier
                .drawBehind { drawRect(Dray.border, Offset.Zero, size.copy(width = 3.dp.toPx())) }
                .padding(start = 12.dp),
            style = style.copy(color = Dray.secondary),
        )
        is MdBlock.Code -> Box(Modifier.fillMaxWidth().well()) {
            Text(
                block.text,
                Modifier.horizontalScroll(rememberScrollState()).padding(12.dp),
                style = Dray.Font.footnote.copy(fontFamily = FontFamily.Monospace),
                softWrap = false,
            )
        }
        MdBlock.Rule -> Box(Modifier.padding(vertical = 4.dp).fillMaxWidth().height(1.dp).background(Dray.border))
        is MdBlock.Image -> InlineImage(ImageRef(url = block.url), fallback = block.alt.ifEmpty { block.url })
        is MdBlock.Table -> Table(block.rows, style)
    }
}

/**
 * A bordered table. Each column takes the width its longest cell asks for, between 72 and 240dp,
 * and the table scrolls sideways where they cannot all fit.
 */
@Composable
private fun Table(rows: List<List<String>>, style: TextStyle) {
    val columns = rows.maxOfOrNull { it.size } ?: 0
    if (columns == 0) return
    val widths = (0 until columns).map { c ->
        val longest = rows.maxOf { (it.getOrNull(c) ?: "").length }
        (longest * 8 + 20).coerceIn(72, 240).dp
    }
    val line = Color.White.copy(alpha = 0.15f)
    val shape = RoundedCornerShape(10.dp)
    Box(Modifier.horizontalScroll(rememberScrollState())) {
        Column(Modifier.clip(shape).border(1.dp, line, shape)) {
            rows.forEachIndexed { r, row ->
                if (r > 0) Box(Modifier.height(1.dp).width(widths.fold(0.dp) { a, b -> a + b }).background(line))
                Row(Modifier.height(IntrinsicSize.Min)) {
                    for (c in 0 until columns) {
                        if (c > 0) Box(Modifier.width(1.dp).fillMaxHeight().background(line))
                        Text(
                            inlineMarkdown(row.getOrNull(c) ?: ""),
                            Modifier
                                .width(widths[c])
                                .fillMaxHeight()
                                .background(if (r == 0) Color.White.copy(alpha = 0.06f) else Color.Transparent)
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                            style = style.copy(fontWeight = if (r == 0) FontWeight.SemiBold else style.fontWeight),
                        )
                    }
                }
            }
        }
    }
}
