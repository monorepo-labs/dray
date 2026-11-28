package com.yogesh.dray.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.yogesh.dray.voice.Dictation
import com.yogesh.dray.voice.loudness
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.sin

/**
 * The voice orb in every state the docks draw, the Island's Orb Lab in small: idle, listening in
 * silence, listening to a voice, transcribing, and one orb walking through them all as a dictation
 * does. The voice is a synthetic speech envelope, since an emulator has no microphone to speak
 * into. Each row draws on the GPU shader and on the CPU path a phone before Android 13 takes.
 * `adb shell am start -n com.dray.app/com.yogesh.dray.ui.OrbDemoActivity`
 */
class OrbDemoActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { DrayTheme { Demo() } }
    }
}

/** Syllables at about 4 a second inside phrases of about 1.5s, as a voice's peaks run. */
private fun voice(ms: Long): Float {
    val s = ms / 1000.0
    val phrase = if ((s % 2.2) < 1.6) 1.0 else 0.15
    val syllable = abs(sin(s * 2 * Math.PI * 2.1)) * 0.7 + 0.3 * abs(sin(s * 7.3))
    return (0.004 + 0.12 * phrase * syllable).toFloat()
}

@Composable
private fun Demo() {
    val start = remember { System.currentTimeMillis() }
    var cycle by remember { mutableStateOf(Dictation.Idle) }
    LaunchedEffect(Unit) {
        while (true) {
            cycle = Dictation.Idle; delay(1800)
            cycle = Dictation.Recording; delay(4500)
            cycle = Dictation.Transcribing; delay(2600)
        }
    }
    Column(
        Modifier.fillMaxSize().background(Dray.page).statusBarsPadding().padding(vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Voice orb", style = Dray.Font.headline)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            Text("GPU (Android 13+)", style = Dray.Font.footnote.copy(color = Dray.tertiary))
            Text("CPU (Android 8–12)", style = Dray.Font.footnote.copy(color = Dray.tertiary))
        }
        Case("Idle", Dictation.Idle) { 0f }
        Case("Listening, silent", Dictation.Recording) { 0f }
        Case("Listening to a voice", Dictation.Recording) { voice(System.currentTimeMillis() - start) }
        Case("Transcribing", Dictation.Transcribing) { 0f }
        Case("A whole dictation: ${cycle.name.lowercase()}", cycle) {
            if (cycle == Dictation.Recording) voice(System.currentTimeMillis() - start) else 0f
        }
    }
}

@Composable
private fun Case(label: String, state: Dictation, level: () -> Float) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(56.dp)) {
            OrbBox(state, cpu = false, level)
            OrbBox(state, cpu = true, level)
        }
        Text(label, style = Dray.Font.footnote.copy(color = Dray.secondary))
    }
}

/** Drawn as the docks draw it: the raw peak through `loudness`, as `Dictations.level` hands it over. */
@Composable
private fun OrbBox(state: Dictation, cpu: Boolean, level: () -> Float) {
    VoiceOrb(100.dp, state, cpu) { loudness(level()) }
}
