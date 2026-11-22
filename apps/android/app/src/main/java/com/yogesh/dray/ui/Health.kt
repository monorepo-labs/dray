package com.yogesh.dray.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.net.Problem
import com.yogesh.dray.store.Store
import kotlinx.coroutines.delay

/**
 * What to say about one server that is not simply working: a line, a reason, and the one
 * thing to do about it. Every surface naming a server's state reads it here, so they agree.
 */
data class Health(
    val title: String,
    val detail: String? = null,
    /** When it tries again on its own (epoch ms); the detail counts down to it. */
    val until: Long? = null,
    val action: Action? = null,
    /** The reader has to do something, rather than wait: drawn in the yellow. */
    val needsYou: Boolean = false,
    val icon: ImageVector = Icons.Outlined.WarningAmber,
    /** Already trying again, so an orb says so instead of an icon. */
    val working: Boolean = false,
) {
    enum class Action { Retry, Fix }

    companion object {
        fun offline(detail: String) = Health("You're offline", detail, icon = Icons.Outlined.WifiOff)
    }
}

/** Nil while the server is fine, or still on its first try, which is quick and would only flash. */
fun Store.health(id: String): Health? {
    val name = name(id)
    return when (val state = serverState[id]) {
        ConnState.Connected -> loadErrors[id]?.let { Health("Couldn't load sessions from $name", sentence(it), action = Health.Action.Retry) }
        is ConnState.Connecting -> if (state.attempt == 0 || !online) null else Health("Reconnecting to $name…", working = true)
        is ConnState.Waiting -> if (!online || state.problem == Problem.Offline) null
            else Health("Can't reach $name", until = state.until, action = Health.Action.Retry, icon = Icons.Outlined.CloudOff)
        is ConnState.Failed -> when (state.problem) {
            Problem.Auth -> Health("$name refused the token", "Pair this phone again, or paste a new token.",
                action = Health.Action.Fix, needsYou = true, icon = Icons.Outlined.Key)
            Problem.ServerOlder -> Health("$name needs an update", "Run dray update there, then retry.",
                action = Health.Action.Retry, needsYou = true, icon = Icons.Outlined.SystemUpdate)
            Problem.ServerNewer -> Health("This app needs an update", "$name is newer than this app. Update Dray, then retry.",
                action = Health.Action.Retry, needsYou = true, icon = Icons.Outlined.SystemUpdate)
            Problem.BadAddress -> Health("$name has no valid address", "Remove it and add it again.",
                action = Health.Action.Fix, needsYou = true, icon = Icons.Outlined.CloudOff)
            else -> Health("Can't reach $name", action = Health.Action.Retry, icon = Icons.Outlined.CloudOff)
        }
        null -> null
    }
}

/** One server's state in a word or two, for its row among the servers. */
fun Store.stateLabel(id: String): String {
    if (servers.firstOrNull { it.id == id }?.on == false) return "Off"
    return when (val s = serverState[id]) {
        ConnState.Connected -> "Connected"
        null -> "Connecting…"
        is ConnState.Connecting -> if (s.attempt == 0) "Connecting…" else "Reconnecting…"
        is ConnState.Waiting -> if (online) "Can't reach it" else "Offline"
        is ConnState.Failed -> when (s.problem) {
            Problem.Auth -> "Token refused"
            Problem.ServerOlder -> "Server needs an update"
            Problem.ServerNewer -> "App needs an update"
            Problem.BadAddress -> "Invalid address"
            else -> "Can't reach it"
        }
    }
}

/** "Trying again in 8s", counting down to `until`, then "Trying again…". */
@Composable
fun countdown(until: Long): String {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(until) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    val left = ((until - now + 999) / 1000).toInt()
    return if (left > 0) "Trying again in ${left}s" else "Trying again…"
}

/**
 * One server's trouble, or the network's: what it is, why, and its one action. `floating` is
 * the session's, laid over the transcript under the title bar; otherwise a card in the list.
 */
@Composable
fun HealthBanner(health: Health, floating: Boolean = false, retry: () -> Unit = {}, fix: () -> Unit = {}) {
    val shape = RoundedCornerShape(if (floating) 16.dp else Dray.Radius.lg)
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (floating) Modifier.shadow(12.dp, shape).clip(shape).background(Dray.raised).border(0.5.dp, Color.White.copy(alpha = 0.14f), shape)
                  else Modifier.clip(shape).background(Dray.card))
            .heightIn(min = if (floating) 0.dp else 64.dp)
            .padding(horizontal = 14.dp, vertical = if (floating) 8.dp else 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
            if (health.working) Orb(OrbKind.Reconnecting, 20.dp)
            else Icon(health.icon, null, tint = if (health.needsYou) Dray.accent else Dray.secondary)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(health.title, style = Dray.Font.subhead)
            health.detail?.let { Text(it, style = Dray.Font.footnote.copy(color = Dray.secondary)) }
            health.until?.let { Text(countdown(it), style = Dray.Font.footnote.copy(color = Dray.secondary)) }
        }
        health.action?.let { action ->
            Text(
                if (action == Health.Action.Fix) "Fix" else "Retry",
                Modifier.clip(RoundedCornerShape(8.dp)).clickable { if (action == Health.Action.Fix) fix() else retry() }.padding(6.dp),
                style = Dray.Font.pill.copy(color = if (health.needsYou) Dray.accent else Dray.text),
            )
        }
    }
}

/** A session's server when it is not connected — only once it is really lost: a quick reconnect says nothing. */
@Composable
fun SessionBanner(server: String, fix: () -> Unit) {
    val store = LocalStore.current
    val lost = server in store.lost
    val health = when {
        !lost -> null
        !store.online -> Health.offline("The task keeps running on ${store.name(server)}.")
        else -> store.health(server)
    }
    AnimatedVisibility(health != null, enter = slideInVertically() + fadeIn(), exit = slideOutVertically() + fadeOut()) {
        health?.let {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                HealthBanner(it, floating = true, retry = { store.retry(server) }, fix = fix)
            }
        }
    }
}

/** An action that failed with nowhere of its own to say so, drawn over the top for a moment — never an alert. */
@Composable
fun ErrorToast() {
    val store = LocalStore.current
    val message = store.lastError
    LaunchedEffect(message) {
        if (message == null) return@LaunchedEffect
        delay(4000)
        if (store.lastError == message) store.lastError = null
    }
    AnimatedVisibility(message != null, enter = slideInVertically() + fadeIn(), exit = slideOutVertically() + fadeOut()) {
        val shape = RoundedCornerShape(Dray.Radius.lg)
        Row(
            Modifier
                .padding(16.dp)
                .fillMaxWidth()
                .shadow(16.dp, shape)
                .clip(shape)
                .background(Dray.raised)
                .border(1.dp, Dray.border, shape)
                .clickable { store.lastError = null }
                .padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Filled.Error, null, Modifier.size(18.dp), tint = Dray.destructive)
            Text(sentence(message ?: ""), style = Dray.Font.subhead)
        }
    }
}
