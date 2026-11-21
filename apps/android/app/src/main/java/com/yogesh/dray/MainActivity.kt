package com.yogesh.dray

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.yogesh.dray.net.PairLink
import com.yogesh.dray.ui.App
import com.yogesh.dray.ui.DrayTheme
import com.yogesh.dray.ui.LocalStore

class MainActivity : ComponentActivity() {
    /** A `dray://connect` link the app was opened with, waiting for the add screen to take it. */
    private var incoming by mutableStateOf<PairLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) take(intent)
        val store = (application as DrayApplication).store
        setContent {
            DrayTheme {
                CompositionLocalProvider(LocalStore provides store) {
                    App(incoming) { incoming = null }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        take(intent)
    }

    private fun take(intent: Intent?) {
        intent?.dataString?.let { PairLink.parse(it) }?.let { incoming = it }
    }
}
