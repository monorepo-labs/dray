package com.yogesh.dray.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.wire.bool
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.jsonOf
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** One dev server the desktop's Browser tab lists; `local_servers.rs`'s `LocalServer`. */
@Serializable
data class LocalServer(
    val port: Int,
    val process: String = "",
    /** Started under the session's agent, as against by hand in its checkout. */
    val mine: Boolean = false,
    /** Its public link, where somebody shared it. */
    val share: String? = null,
)

/**
 * A session's dev servers on its machine, each shareable by public link. Nothing on the wire
 * announces a server or a share, so the list is re-read every 5s while on screen, the desktop's rhythm.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LocalServersSheet(key: SessionKey, dismiss: () -> Unit) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    var servers by remember { mutableStateOf<List<LocalServer>?>(null) }
    var readError by remember { mutableStateOf<String?>(null) }
    var sharing by remember { mutableStateOf<Pair<Int, Long>?>(null) }
    // The first share on a machine registers its tunnel, a wait of minutes.
    var settingUp by remember { mutableStateOf(false) }
    val failures = remember { mutableStateMapOf<Int, String>() }

    suspend fun read() {
        try {
            val list = decodeList<LocalServer>(store.call(key.server, "list_local_servers", jsonOf("sessionId" to key.id)))
            servers = list
            readError = null
            // A share whose answer was lost with the socket can still land.
            list.filter { it.share != null }.forEach { failures.remove(it.port) }
        } catch (e: Exception) {
            // A failed poll keeps the last list; only an empty sheet says why.
            readError = sentence(e.message ?: "Couldn't list servers")
        }
    }
    LaunchedEffect(key) {
        while (true) {
            read()
            delay(5000)
        }
    }
    fun share(port: Int) {
        failures.remove(port)
        sharing = port to System.currentTimeMillis()
        settingUp = false
        scope.launch { runCatching { store.call(key.server, "share_ready") }.getOrNull()?.bool?.let { settingUp = !it } }
        scope.launch {
            try {
                // Past the server's own bounds (5 min provisioning, 90s attach), so its sentence arrives rather than this side's timeout.
                store.call(key.server, "share_port", jsonOf("sessionId" to key.id, "port" to port), timeoutMs = 420_000)
            } catch (e: Exception) {
                failures[port] = sentence(e.message ?: "Couldn't share it")
            }
            sharing = null
            read()
        }
    }
    fun stop(port: Int) = scope.launch {
        runCatching { store.call(key.server, "stop_share", jsonOf("sessionId" to key.id, "port" to port)) }
            .onFailure { failures[port] = sentence(it.message ?: "Couldn't stop it") }
        read()
    }

    ModalBottomSheet(dismiss, containerColor = Dray.card) {
        Column(Modifier.fillMaxWidth().heightIn(min = 320.dp).padding(bottom = 24.dp)) {
            Text("Local servers", Modifier.padding(horizontal = 20.dp).padding(bottom = 12.dp), style = Dray.Font.headline)
            val list = servers
            when {
                !list.isNullOrEmpty() -> Column(
                    Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (s in list) ServerRow(s, sharing, settingUp, failures[s.port], { share(s.port) }, { stop(s.port) })
                    Text("A public link is one anyone can open, until you stop it.", Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        style = Dray.Font.footnote.copy(color = Dray.tertiary))
                }
                list != null -> Empty(Icons.Outlined.Language, "No servers running",
                    "Dev servers this task starts, or ones started in its checkout, show here.")
                readError != null -> Empty(Icons.Outlined.WarningAmber, "Couldn't list servers", readError!!) {
                    Text("Try again", Modifier.padding(top = 14.dp).clip(CircleShape).background(Dray.raised)
                        .clickable { scope.launch { read() } }.padding(horizontal = 16.dp, vertical = 8.dp), style = Dray.Font.pill)
                }
                else -> Box(Modifier.fillMaxWidth().height(200.dp), Alignment.Center) { Orb(OrbKind.Loading, 32.dp) }
            }
        }
    }
}

/** The sheet's own empty state: smaller than the list's, since a sheet's title is already a headline. */
@Composable
private fun Empty(icon: ImageVector, title: String, message: String, action: @Composable () -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(top = 32.dp, bottom = 48.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, null, Modifier.size(36.dp), tint = Dray.tertiary)
        Text(title, Modifier.padding(top = 8.dp), style = Dray.Font.headline)
        Text(message, Modifier.widthIn(max = 280.dp), style = Dray.Font.subhead.copy(color = Dray.secondary), textAlign = TextAlign.Center)
        action()
    }
}

@Composable
private fun ServerRow(s: LocalServer, sharing: Pair<Int, Long>?, settingUp: Boolean, failure: String?, share: () -> Unit, stop: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.raised).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("localhost:${s.port}", style = Dray.Font.body)
            Text(if (s.mine) "${s.process} · started by this task" else s.process,
                style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        when {
            s.share != null -> Shared(s.share, stop)
            sharing?.first == s.port -> Waiting(sharing.second, settingUp)
            else -> Row(
                Modifier.fillMaxWidth().height(40.dp).alpha(if (sharing != null) 0.45f else 1f).clip(CircleShape).background(Dray.tile)
                    .clickable(enabled = sharing == null, onClick = share),
                horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.Link, null, Modifier.size(18.dp), tint = Dray.text)
                Text("Get public link", style = Dray.Font.pill)
            }
        }
        failure?.let { Text(it, style = Dray.Font.subhead.copy(color = Dray.destructive)) }
    }
}

/** The share's wait, and past half a minute what it is waiting on, so a stalled relay reads as one rather than as a spinner. */
@Composable
private fun Waiting(since: Long, settingUp: Boolean) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(since) { while (true) { now = System.currentTimeMillis(); delay(5000) } }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OrbLine(OrbKind.Working, if (settingUp) "Setting up tunnel…" else "Creating link…")
        if (now - since >= 30_000) Text(
            if (settingUp) "A first link registers the tunnel, which can take a few minutes. It shows here once it's up, or why it failed."
            else "Still waiting on the relay. The link shows here once it's up, or why it failed.",
            style = Dray.Font.footnote.copy(color = Dray.secondary),
        )
    }
}

@Composable
private fun Shared(link: String, stop: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            Modifier.weight(1f).clickable { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Outlined.Link, null, Modifier.size(18.dp), tint = Dray.secondary)
            Text(Uri.parse(link).host ?: link, style = Dray.Font.subhead, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Round(if (copied) Icons.Filled.Check else Icons.Outlined.ContentCopy, if (copied) "Copied" else "Copy link") {
            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Link", link))
            copied = true
            scope.launch { delay(2000); copied = false }
        }
        Round(Icons.Outlined.Share, "Share link") {
            context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, link) }, null))
        }
        Round(Icons.Filled.Close, "Stop sharing", stop)
    }
}

@Composable
private fun Round(icon: ImageVector, label: String, onClick: () -> Unit) {
    Box(Modifier.size(36.dp).clip(CircleShape).background(Dray.tile).clickable(onClick = onClick), Alignment.Center) {
        Icon(icon, label, Modifier.size(18.dp), tint = Dray.text)
    }
}
