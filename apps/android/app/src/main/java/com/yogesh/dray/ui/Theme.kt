package com.yogesh.dray.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Every colour, size, radius and font the app draws with, and nowhere else: the iOS app's
 * Theme.swift, which is the desktop's dark tokens, its one yellow and its radius scale.
 * Dark only. Yellow means *needs you* — a card, a refused token — and nothing else.
 */
object Dray {
    val page = Color(0xFF0A0A0A)
    val well = Color(0xFF141414)
    val lifted = Color(0xFF171717)
    val card = Color(0xFF1A1A1A)
    val raised = Color(0xFF262626)
    val selected = Color(0xFF2B2B2B)
    val tile = Color(0xFF333333)
    val off = Color(0xFF3A3A3A)
    val dim = Color(0xFF525252)

    val text = Color(0xFFFAFAFA)
    val secondary = Color(0xFFA1A1A1)
    val tertiary = Color(0xFF737373)
    val primary = Color(0xFFEBEBEB)
    val onPrimary = Color(0xFF171717)
    /** The reader's own bubble, specified in Display P3 as the iOS app draws it. */
    val sent = Color(0.192f, 0.454f, 0.806f, 1f, ColorSpaces.DisplayP3)
    val onSent = Color(0xFFFCFCFC)

    val hairline = Color.White.copy(alpha = 0.06f)
    val border = Color.White.copy(alpha = 0.10f)
    val connector = Color(0xFF404040)
    val accent = Color(0xFFE5C057)
    val add = Color(0xFF09BB83)
    val destructive = Color(0xFFFF6467)
    val merged = Color(0xFFA855F7)
    val merge = Color(0xFF238636)
    val link = Color(0xFF5AD3FF)
    val claude = Color(0xFFD97757)

    object Radius {
        val sm = 8.dp
        val md = 10.dp
        val tile = 12.dp
        val lg = 14.dp
        val group = 18.dp
        val xl = 20.dp
    }

    object Space {
        val xs = 4.dp
        val s = 8.dp
        val m = 12.dp
        val l = 16.dp
        val xl = 24.dp
        val xxl = 32.dp
    }

    /** One type scale, five rungs, regular and semibold only. */
    object Font {
        val title = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold, color = text)
        val headline = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, color = text)
        val body = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, color = text)
        val subhead = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, color = text)
        val pill = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, color = text)
        val footnote = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, color = text)
        val footnoteStrong = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold, color = text)
        val code = TextStyle(fontSize = 12.sp, lineHeight = 17.sp, fontFamily = FontFamily.Monospace, color = text)
    }
}

private val scheme = darkColorScheme(
    primary = Dray.primary,
    onPrimary = Dray.onPrimary,
    secondary = Dray.secondary,
    background = Dray.page,
    onBackground = Dray.text,
    surface = Dray.page,
    onSurface = Dray.text,
    surfaceVariant = Dray.raised,
    onSurfaceVariant = Dray.secondary,
    surfaceContainer = Dray.card,
    surfaceContainerLow = Dray.card,
    surfaceContainerHigh = Dray.raised,
    surfaceContainerHighest = Dray.tile,
    outline = Dray.border,
    outlineVariant = Dray.hairline,
    error = Dray.destructive,
)

@Composable
fun DrayTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, content = content)
}

/** Code and tool output sit in this: the well fill, its radius and a hairline. */
fun Modifier.well(): Modifier = clip(RoundedCornerShape(Dray.Radius.md))
    .background(Dray.well)
    .border(1.dp, Dray.hairline, RoundedCornerShape(Dray.Radius.md))

fun Modifier.card(radius: androidx.compose.ui.unit.Dp = Dray.Radius.lg): Modifier = clip(RoundedCornerShape(radius))
    .background(Dray.card)
    .border(1.dp, Dray.hairline, RoundedCornerShape(radius))

/** A server error opens lowercase, written to follow a colon; a sentence here stands on its own. */
fun sentence(s: String): String = s.replaceFirstChar { it.uppercase() }
