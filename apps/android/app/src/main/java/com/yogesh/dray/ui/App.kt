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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import com.yogesh.dray.store.OpenIntoBot
import com.yogesh.dray.store.allBots
import com.yogesh.dray.store.botChat
import kotlinx.coroutines.delay
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.net.PairLink
import com.yogesh.dray.store.NewTask
import com.yogesh.dray.store.Store
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
    data object Pulls : Route
    data class Pull(val target: PullTarget) : Route
    data object Issues : Route
    data class Issue(val server: String, val id: String, val identifier: String) : Route

    /** A route as strings, for the saved state a rotation restores the stack from. */
    fun save(): kotlin.collections.List<String> = when (this) {
        List -> listOf("list")
        is Session -> listOf("session", key.server, key.id)
        is Changes -> listOf("changes", key.server, key.id)
        // The link's token is already in Add server's own saved fields; this restores the same screen over them.
        is Add -> listOf("add", scan.toString(), nonce.toString(), link?.url.orEmpty(), link?.token.orEmpty(), link?.name.orEmpty())
        Settings -> listOf("settings")
        is BotStart -> listOf("bot-start", server, botId)
        is ServerSettings -> listOf("server-settings", id)
        Notifications -> listOf("notifications")
        Dictation -> listOf("dictation")
        Pulls -> listOf("pulls")
        is Pull -> with(target) { listOf("pull", server, key, repo, number.toString(), url, branch) }
        Issues -> listOf("issues")
        is Issue -> listOf("issue", server, id, identifier)
    }

    companion object {
        fun restore(s: kotlin.collections.List<String>): Route? = when (s.firstOrNull()) {
            "list" -> List
            "session" -> Session(SessionKey(s[1], s[2]))
            "changes" -> Changes(SessionKey(s[1], s[2]))
            "add" -> Add(s[3].takeIf { it.isNotEmpty() }?.let { PairLink(it, s[4], s[5].ifEmpty { null }) }, s[1].toBoolean(), s[2].toLong())
            "settings" -> Settings
            "bot-start" -> BotStart(s[1], s[2])
            "server-settings" -> ServerSettings(s[1])
            "notifications" -> Notifications
            "dictation" -> Dictation
            "pulls" -> Pulls
            "pull" -> Pull(PullTarget(s[1], s[2], s[3], s[4].toInt(), s[5], s[6]))
            "issues" -> Issues
            "issue" -> Issue(s[1], s[2], s[3])
            else -> null
        }

        /** The stack through a rotation or a process the system reclaimed: the reader comes back where they were. */
        val stackSaver = listSaver<SnapshotStateList<Route>, ArrayList<String>>(
            save = { stack -> stack.map { ArrayList(it.save()) } },
            restore = { saved -> mutableStateListOf<Route>().apply { addAll(saved.mapNotNull { restore(it) }.ifEmpty { listOf(List) }) } },
        )
    }
}

/** The app's one navigation stack. A pairing link from outside pushes Add server, filled in. */
@Composable
fun App(incoming: PairLink?, consumed: () -> Unit) {
    val store = LocalStore.current
    // "Open bot at launch" puts the bot under the first frame, so the list never shows before it.
    // Only a fresh launch builds this; a restored one keeps the stack the reader left.
    val stack = rememberSaveable(saver = Route.stackSaver) {
        mutableStateListOf<Route>(Route.List).apply {
            if (incoming == null && Push.opening == null) launchRoute(store)?.let(::add)
        }
    }
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
        // Tagged with a copy through a Mac held back since, or the reverse (#1404).
        push(Route.Session(SessionKey(store.shownAs(key.server), key.id)))
    }
    LaunchedEffect(stack.last()) { Push.viewing = (stack.last() as? Route.Session)?.key }
    // With no cached list to open from (a first launch), the bot opens once its server answers instead.
    // Anything that leaves the list first — an alert, a link, the reader's own tap — spends it, as does a slow server.
    var launchSpent by rememberSaveable { mutableStateOf(stack.size > 1) }
    LaunchedEffect(stack.size) { if (stack.size > 1) launchSpent = true }
    LaunchedEffect(Unit) { delay(10_000); launchSpent = true }
    val late = if (!launchSpent && store.live.isNotEmpty() && store.live.all { store.known(it.id) }) launchRoute(store) else null
    LaunchedEffect(late) {
        val route = late ?: return@LaunchedEffect
        launchSpent = true
        push(route)
    }
    NotificationAsk()
    val holder = rememberSaveableStateHolder()
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
                    openPulls = { push(Route.Pulls) },
                    openIssues = { push(Route.Issues) },
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
                Route.Pulls -> PullsScreen(::pop) { row ->
                    push(Route.Pull(PullTarget(row.server, row.key, row.repoName, row.mark.number, row.id, row.mark.headRefName)))
                }
                is Route.Pull -> PullDetailScreen(route.target, ::pop) { push(Route.Session(it)) }
                Route.Issues -> IssuesScreen(::pop) { server, issue -> push(Route.Issue(server, issue.id, issue.identifier)) }
                is Route.Issue -> IssueDetailScreen(route.server, route.id, route.identifier, ::pop) { push(Route.Session(it)) }
            } }
        }
        Box(Modifier.align(Alignment.TopCenter).statusBarsPadding()) { ErrorToast() }
    } }
}

/**
 * Where "Open bot at launch" goes, read off the store as it stands: the picked bot's chat, or its
 * start screen where it has none yet. The cached list answers this before any socket is up.
 */
private fun launchRoute(store: Store): Route? {
    if (!OpenIntoBot.on) return null
    val (server, bot) = OpenIntoBot.target(store.allBots) ?: return null
    return store.botChat(server, bot).lastOrNull()?.let { Route.Session(it) } ?: Route.BotStart(server, bot.id)
}
