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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.net.PairLink
import com.yogesh.dray.store.NewTask
import com.yogesh.dray.push.Push

/** Where the app is: the list at the bottom of a stack, everything else pushed over it. */
sealed interface Route {
    data object List : Route
    data class Session(val key: SessionKey) : Route
    data class Changes(val key: SessionKey) : Route
    data class Add(val link: PairLink? = null, val scan: Boolean = false, val nonce: Long = System.nanoTime()) : Route
    data object Settings : Route
    /** A bot with no chat yet: its greeting, and the first message that starts one. */
    data class BotStart(val server: String, val botId: String) : Route
    /** Settings opened on one server's page, as a banner's Fix does. */
    data class ServerSettings(val id: String) : Route
    data object Notifications : Route
    data object Dictation : Route
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
    // A tapped alert opens its chat over the list, wherever the reader was.
    LaunchedEffect(Push.opening) {
        val key = Push.opening ?: return@LaunchedEffect
        Push.opening = null
        stack.removeAll { it != Route.List }
        push(Route.Session(key))
    }
    LaunchedEffect(stack.last()) { Push.viewing = (stack.last() as? Route.Session)?.key }
    NotificationAsk()
    val holder = rememberSaveableStateHolder()
    val store = LocalStore.current
    val context = LocalContext.current
    val task = remember { NewTask(store, context.applicationContext) }

    CompositionLocalProvider(LocalNewTask provides task) { Box(Modifier.fillMaxSize()) {
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
                    startBot = { server, bot -> push(Route.BotStart(server, bot)) },
                )
                is Route.Session -> {
                    val bot = store.bot(route.key)
                    if (bot != null) BotChatScreen(route.key, bot, ::pop, openTask = { push(Route.Session(it)) },
                        openSession = { push(Route.Session(it)) }) { push(Route.ServerSettings(it)) }
                    else TranscriptScreen(route.key, ::pop, openChanges = { push(Route.Changes(route.key)) }) { push(Route.ServerSettings(it)) }
                }
                is Route.Changes -> ChangesScreen(route.key, ::pop)
                is Route.BotStart -> store.bots[route.server]?.firstOrNull { it.id == route.botId }?.let { bot ->
                    BotStartScreen(route.server, bot, ::pop) { key ->
                        stack.removeAt(stack.lastIndex)
                        push(Route.Session(key))
                    }
                } ?: LaunchedEffect(Unit) { pop() }
                is Route.Add -> AddServerScreen(route.link, route.scan, ::pop)
                Route.Settings -> SettingsScreen(null, ::pop, { push(Route.Dictation) }, { push(Route.Notifications) }) { push(Route.Add()) }
                is Route.ServerSettings -> SettingsScreen(route.id, ::pop, { push(Route.Dictation) }, { push(Route.Notifications) }) { push(Route.Add()) }
                Route.Notifications -> NotificationSettings(::pop)
                Route.Dictation -> DictationSettings(::pop)
            } }
        }
        Box(Modifier.align(Alignment.TopCenter).statusBarsPadding()) { ErrorToast() }
    } }
}
