package com.yogesh.dray.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

/**
 * Whether every reaction sits at the centre of its badge by eye, on this phone's emoji font: each
 * drawn as the text box puts it (raw) and as [ReactionBadge] does, at real size and blown up
 * four times, plain as the app draws them, with the nudge under each in pixels.
 * `adb shell am start -n com.dray.app/com.yogesh.dray.ui.ReactionDemoActivity`
 */
class ReactionDemoActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { DrayTheme { Demo() } }
    }
}

/** The badge as it drew before centring: the text box at the circle's centre. */
@Composable
private fun RawBadge(emoji: String) {
    Box(
        Modifier.size(40.dp).clip(CircleShape).background(Dray.page).border(1.dp, Dray.border, CircleShape),
        contentAlignment = Alignment.Center,
    ) { Text(emoji, style = reactionStyle) }
}

@Composable
private fun Badge(emoji: String, raw: Boolean, scale: Float) {
    Box(Modifier.size(40.dp * scale)) {
        Box(Modifier.size(40.dp).graphicsLayer { scaleX = scale; scaleY = scale; transformOrigin = TransformOrigin(0f, 0f) }) {
            if (raw) RawBadge(emoji) else ReactionBadge(emoji)
        }
    }
}

@Composable
private fun Demo() {
    Column(
        Modifier.fillMaxSize().background(Dray.page).statusBarsPadding().padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        for (raw in listOf(true, false)) {
            Text(if (raw) "Raw: the text box centred" else "ReactionBadge: centred by its ink", style = Dray.Font.footnote.copy(color = Dray.secondary))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) { for (e in reactions) Badge(e, raw, 1f) }
            // Two rows of four at 2x, which fit a phone's width with room for the readout.
            for (row in reactions.chunked(4)) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (e in row) Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Badge(e, raw, 2f)
                    if (!raw) Nudge(e)
                }
            }
        }
    }
}

/** The nudge [ReactionBadge] applies to `emoji`, in pixels. */
@Composable
private fun Nudge(emoji: String) {
    var at by remember { mutableStateOf<Float?>(null) }
    // Laid out off screen, the way the badge lays it out, to read the same numbers.
    Box(Modifier.size(0.dp)) { Text(emoji, Modifier.wrapContentSize(unbounded = true).graphicsLayer { alpha = 0f }, style = reactionStyle, onTextLayout = { at = centring(emoji, it) }) }
    Text(at?.let { "${(it * 10).roundToInt() / 10f}" } ?: "…", style = Dray.Font.footnote.copy(color = Dray.tertiary))
}
