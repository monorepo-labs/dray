package com.yogesh.dray.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.net.PairLink

/** Where the app is: the list at the bottom of a stack, everything else pushed over it. */
sealed interface Route {
    data object List : Route
    data class Session(val key: SessionKey) : Route
    data class Add(val link: PairLink? = null, val scan: Boolean = false, val nonce: Long = System.nanoTime()) : Route
    data object Settings : Route
    /** Settings opened on one server's page, as a banner's Fix does. */
    data class ServerSettings(val id: String) : Route
}

/** The app's one navigation stack. A pairing link from outside pushes Add server, filled in. */
@Composable
fun App(incoming: PairLink?, consumed: () -> Unit) {
    val stack = remember { mutableStateListOf<Route>(Route.List) }
    val forward = remember { mutableStateOf(true) }
    fun push(r: Route) { forward.value = true; stack.add(r) }
    fun pop() { if (stack.size > 1) { forward.value = false; stack.removeAt(stack.lastIndex) } }

    LaunchedEffect(incoming) {
        if (incoming != null) {
            // A link replaces whatever add screen is up rather than stacking a second.
            stack.removeAll { it is Route.Add }
            push(Route.Add(incoming))
            consumed()
        }
    }
    BackHandler(stack.size > 1) { pop() }
    val holder = rememberSaveableStateHolder()

    Box(Modifier.fillMaxSize()) {
        AnimatedContent(
            stack.last(),
            transitionSpec = {
                if (forward.value) (slideInHorizontally { it / 4 } + fadeIn()) togetherWith (slideOutHorizontally { -it / 8 } + fadeOut())
                else (slideInHorizontally { -it / 8 } + fadeIn()) togetherWith (slideOutHorizontally { it / 4 } + fadeOut())
            },
            label = "route",
        ) { route ->
            // Kept per route, so the list comes back scrolled and filtered as it was left.
            holder.SaveableStateProvider(route.toString()) { when (route) {
                Route.List -> ListScreen(
                    openSession = { push(Route.Session(it)) },
                    openSettings = { push(it?.let(Route::ServerSettings) ?: Route.Settings) },
                    addServer = { push(Route.Add(scan = it)) },
                )
                is Route.Session -> TranscriptScreen(route.key, ::pop) { push(Route.ServerSettings(it)) }
                is Route.Add -> AddServerScreen(route.link, route.scan, ::pop)
                Route.Settings -> SettingsScreen(null, ::pop) { push(Route.Add()) }
                is Route.ServerSettings -> SettingsScreen(route.id, ::pop) { push(Route.Add()) }
            } }
        }
        Box(Modifier.align(Alignment.TopCenter).statusBarsPadding()) { ErrorToast() }
    }
}
