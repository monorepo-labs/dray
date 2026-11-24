package com.yogesh.dray.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.yogesh.dray.BuildConfig
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.net.Problem
import com.yogesh.dray.net.http
import com.yogesh.dray.net.parseConnectLine
import com.yogesh.dray.net.socketUrl
import com.yogesh.dray.store.Server
import com.yogesh.dray.store.Store
import com.yogesh.dray.wire.Welcome
import com.yogesh.dray.wire.arr
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.str
import com.yogesh.dray.wire.wireJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import okhttp3.Request

// Settings.swift: a card per server, then Dictation, Notifications and about. Its pages stack inside this screen.

private sealed interface Page {
    data object Root : Page
    data object Servers : Page
    data class Server(val id: String) : Page
}

/**
 * The one Settings screen. Opened on a server's page when a banner's Fix asks, with back going
 * to Settings itself, as on iOS.
 */
@Composable
fun SettingsScreen(focus: String?, back: () -> Unit, dictation: () -> Unit = {}, notifications: () -> Unit = {}, add: () -> Unit) {
    val pages = remember { mutableStateListOf<Page>(Page.Root).apply { if (focus != null) add(Page.Server(focus)) } }
    fun pop() = if (pages.size > 1) { pages.removeAt(pages.lastIndex); Unit } else back()
    BackHandler(onBack = ::pop)
    LaunchedEffect(Unit) { Releases.refresh() }
    when (val page = pages.last()) {
        Page.Root -> SettingsPage("Settings", ::pop) {
            ServerCards(5, open = { pages.add(Page.Server(it)) }, all = { pages.add(Page.Servers) }, add = add)
            RowGroup {
                SettingsRow("Dictation", icon = { Icon(Icons.Outlined.Mic, null, Modifier.size(20.dp), tint = Dray.secondary) }, onClick = dictation)
                SettingsRow("Notifications", icon = { Icon(Icons.Outlined.Notifications, null, Modifier.size(20.dp), tint = Dray.secondary) },
                    value = if (com.yogesh.dray.push.Push.enabled && com.yogesh.dray.push.Push.available) "On" else "Off", onClick = notifications)
            }
            About()
        }
        Page.Servers -> SettingsPage("Servers", ::pop) {
            ServerCards(null, open = { pages.add(Page.Server(it)) }, all = {}, add = add)
        }
        is Page.Server -> ServerDetail(page.id, ::pop)
    }
}

/** A page: its bar, then its groups on the card fill, 28dp apart. */
@Composable
private fun SettingsPage(title: String, back: () -> Unit, fill: Color = Dray.card, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().background(fill).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(56.dp).padding(end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Dray.text) }
            Text(title, style = Dray.Font.headline, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(top = 12.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(28.dp),
            content = content,
        )
    }
}

/** Version, then the site's pages, each opening in the browser. */
@Composable
private fun About() {
    val context = LocalContext.current
    RowGroup {
        SettingsRow("Version", value = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", trailing = false)
        for ((label, url) in listOf(
            "Website" to "https://drayhq.com",
            "Docs" to "https://drayhq.com/docs",
            "Privacy Policy" to "https://drayhq.com/docs/reference/privacy",
            "Terms of Service" to "https://drayhq.com/terms",
        )) {
            RowDivider()
            SettingsRow(label, external = true) { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }
    }
}

/** A card per server and Add server. Past `limit`, the rest sit behind an All servers row; the full page leads with Add server. */
@Composable
private fun ServerCards(limit: Int?, open: (String) -> Unit, all: () -> Unit, add: () -> Unit) {
    val store = LocalStore.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (limit == null) AddServerCard(store.servers.isEmpty(), add)
        for (s in store.servers.take(limit ?: Int.MAX_VALUE)) ServerCard(s) { open(s.id) }
        if (limit != null && store.servers.size > limit) RowGroup { SettingsRow("All servers", value = "${store.servers.size}", onClick = all) }
        if (limit != null) AddServerCard(store.servers.isEmpty(), add)
    }
}

@Composable
private fun ServerCard(server: Server, onClick: () -> Unit) {
    val store = LocalStore.current
    val connected = store.serverState[server.id] == ConnState.Connected
    val update = connected && Releases.newer(store.connection(server.id)?.welcome) != null
    // Its host, or the paired server a relayed one is reached through.
    val place = server.via?.let { "via ${store.name(it.parent)}" } ?: socketUrl(server.url)?.let { Uri.parse(it).host } ?: server.url
    CardRow(onClick) {
        Tile { ServerGlyph(if (connected) Dray.text else Dray.secondary, 20.dp) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(server.name, style = Dray.Font.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                StatusDot(server.id, 7.dp)
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(color = Dray.secondary)) { append("${store.stateLabel(server.id)} · ") }
                        withStyle(SpanStyle(color = if (update) Dray.accent else Dray.tertiary)) { append(if (update) "Update available" else place) }
                    },
                    style = Dray.Font.footnote, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Chevron(false)
    }
}

@Composable
private fun AddServerCard(first: Boolean, onClick: () -> Unit) {
    CardRow(onClick) {
        Tile { Icon(Icons.Filled.Add, null, Modifier.size(22.dp), tint = Dray.text) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Add server", style = Dray.Font.body)
            // No server yet: the card says what a server is.
            if (first) Text("Pair with a machine running Dray.", style = Dray.Font.footnote.copy(color = Dray.secondary))
        }
        Chevron(false)
    }
}

@Composable
private fun CardRow(onClick: () -> Unit, content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.group)).background(Dray.raised).clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

/** A 40dp icon tile on a raised card. */
@Composable
private fun Tile(size: Dp = 40.dp, content: @Composable () -> Unit) {
    Box(Modifier.size(size).clip(RoundedCornerShape(Dray.Radius.tile)).background(Dray.tile), contentAlignment = Alignment.Center) { content() }
}

/** A server: two stacked units, each with its light. The holes are cut, so whatever the glyph sits on shows through. */
@Composable
fun ServerGlyph(color: Color, size: Dp) {
    Canvas(Modifier.size(size)) {
        val s = this.size.width / 24f
        val p = Path().apply { fillType = PathFillType.EvenOdd }
        for (top in listOf(2f, 12.5f)) {
            p.addRoundRect(RoundRect(Rect(Offset(s, top * s), androidx.compose.ui.geometry.Size(22 * s, 8.5f * s)), CornerRadius(2.5f * s)))
            p.addOval(Rect(Offset(4.5f * s, (top + 2.75f) * s), androidx.compose.ui.geometry.Size(3 * s, 3 * s)))
        }
        drawPath(p, color)
    }
}

/** A server's dot: green working, yellow needs the reader, dim on its way, grey when switched off. */
@Composable
fun StatusDot(server: String, size: Dp = 8.dp) {
    val store = LocalStore.current
    val state = store.serverState[server]
    val tone = when {
        store.servers.firstOrNull { it.id == server }?.on == false -> Dray.tertiary
        state == ConnState.Connected -> if (store.loadErrors[server] == null) Dray.add else Dray.accent
        state is ConnState.Failed && !state.problem.retries -> Dray.accent
        else -> Dray.dim
    }
    Box(Modifier.size(size).clip(CircleShape).background(tone))
}

/** Rows sharing one raised card, as a grouped list draws them. */
@Composable
fun RowGroup(fill: Color = Dray.raised, radius: Dp = Dray.Radius.lg, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(radius)).background(fill), content = content)
}

@Composable
fun RowDivider(inset: Dp = 16.dp) = HorizontalDivider(Modifier.padding(start = inset), color = Dray.hairline)

@Composable
fun GroupLabel(text: String) = Text(text, Modifier.padding(horizontal = 12.dp), style = Dray.Font.footnote.copy(color = Dray.tertiary))

/** One 52dp row: an icon, a label, its value on the same line, and where it goes. */
@Composable
private fun SettingsRow(
    label: String, icon: (@Composable () -> Unit)? = null, value: String? = null, trailing: Boolean = true,
    external: Boolean = false, onClick: (() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(start = 16.dp, end = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        icon?.let { Box(Modifier.width(20.dp), contentAlignment = Alignment.Center) { it() } }
        Text(label, Modifier.weight(1f), style = Dray.Font.body)
        value?.let { Text(it, style = Dray.Font.body.copy(color = Dray.secondary), maxLines = 1) }
        when {
            external -> Icon(Icons.AutoMirrored.Filled.OpenInNew, null, Modifier.size(16.dp), tint = Dray.tertiary)
            trailing && onClick != null -> Chevron(false)
        }
    }
}

@Composable
private fun SwitchRow(label: String, on: Boolean, content: (@Composable () -> Unit)? = null, set: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(start = 16.dp, end = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) { content?.invoke() ?: Text(label, style = Dray.Font.body) }
        Switch(on, set, colors = SwitchDefaults.colors(
            checkedTrackColor = Dray.primary, checkedThumbColor = Dray.onPrimary, uncheckedTrackColor = Dray.off,
            uncheckedThumbColor = Dray.secondary, uncheckedBorderColor = Dray.off))
    }
}

/** A labelled field, 52dp: the label in a 72dp lane, the value beside it at the same size. */
@Composable
private fun FieldRow(label: String, value: String, prompt: String, done: () -> Unit = {}, onChange: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.width(72.dp), style = Dray.Font.body.copy(color = Dray.secondary))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) Text(prompt, style = Dray.Font.body.copy(color = Dray.tertiary), maxLines = 1, overflow = TextOverflow.Ellipsis)
            BasicTextField(
                value, onChange, Modifier.fillMaxWidth(),
                textStyle = Dray.Font.body,
                singleLine = true,
                cursorBrush = SolidColor(Dray.text),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { done() }),
            )
        }
    }
}

/** A small filled capsule: a card's one action. */
@Composable
private fun Pill(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Text(
        label,
        Modifier.alpha(if (enabled) 1f else 0.45f).height(36.dp).clip(CircleShape).background(Dray.primary)
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp),
        style = Dray.Font.pill.copy(color = Dray.onPrimary),
    )
}

/** One server: its state and the cure, its name, address and token, and removing it. */
@Composable
private fun ServerDetail(id: String, back: () -> Unit) {
    val store = LocalStore.current
    val server = store.servers.firstOrNull { it.id == id }
    var name by remember(id) { mutableStateOf(server?.name ?: "") }
    var token by remember(id) { mutableStateOf("") }
    var tokenSaved by remember(id) { mutableStateOf(false) }
    var removing by remember { mutableStateOf(false) }
    var scanning by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    val context = LocalContext.current

    fun rename() {
        val trimmed = name.trim()
        val now = store.servers.firstOrNull { it.id == id } ?: return
        if (trimmed.isNotEmpty() && trimmed != now.name) store.renameServer(id, trimmed)
    }
    val renameNow by rememberUpdatedState(::rename)
    DisposableEffect(id) { onDispose { renameNow() } }

    if (scanning) {
        ScanScreen({ link -> store.updateToken(id, link.token); scanning = false; tokenSaved = true }) { scanning = false }
        return
    }
    // Removed from under the page: there is nothing left to show.
    if (server == null) {
        LaunchedEffect(Unit) { back() }
        return
    }
    SettingsPage(server.name, back, fill = Dray.page) {
        if (server.via != null) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                RowGroup(Dray.card, Dray.Radius.group) { Box(Modifier.heightIn(min = 52.dp).padding(horizontal = 16.dp), Alignment.CenterStart) { StateLine(server) } }
                GroupLabel("Reached through ${store.name(server.via.parent)}, which shares it. It goes when ${store.name(server.via.parent)} stops sharing.")
            }
            StatusCard(id) { scanning = true }
            return@SettingsPage
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RowGroup(Dray.card, Dray.Radius.group) {
                SwitchRow("", server.on, content = { StateLine(server) }) { store.setServerOn(id, it) }
            }
            GroupLabel(if (server.on) "Off stops this phone connecting and hides its tasks. Nothing stops on the server."
                       else "Its tasks are hidden until you turn it back on. They keep running on ${server.name}.")
        }
        StatusCard(id) { scanning = true }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RowGroup(Dray.card, Dray.Radius.group) {
                FieldRow("Name", name, server.name, done = ::rename) { name = it }
                RowDivider()
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable {
                        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Address", server.url))
                        copied = true
                    }.padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text("Address", Modifier.width(72.dp), style = Dray.Font.body.copy(color = Dray.secondary))
                    Text(server.url, Modifier.weight(1f), style = Dray.Font.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Icon(if (copied) Icons.Filled.Check else Icons.Outlined.ContentCopy, "Copy address", Modifier.size(18.dp), tint = Dray.tertiary)
                }
                RowDivider()
                FieldRow("Token", token, "Paste a new token") { text ->
                    token = text
                    newToken(text)?.let {
                        store.updateToken(id, it)
                        token = ""
                        tokenSaved = true
                    }
                }
            }
            GroupLabel(if (tokenSaved) "New token saved." else "A whole connect line works too.")
        }
        Text(
            "Remove server",
            Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(RoundedCornerShape(Dray.Radius.group)).background(Dray.card)
                .clickable { removing = true }.padding(horizontal = 16.dp, vertical = 15.dp),
            style = Dray.Font.body.copy(color = Dray.destructive),
        )
    }
    if (removing) AlertDialog(
        onDismissRequest = { removing = false },
        title = { Text("Remove ${server.name}?") },
        text = { Text("Its sessions keep running there. This phone stops showing them.") },
        confirmButton = { TextButton({ removing = false; store.removeServer(server); back() }) { Text("Remove", color = Dray.destructive) } },
        dismissButton = { TextButton({ removing = false }) { Text("Cancel", color = Dray.text) } },
        containerColor = Dray.card,
    )
}

/** A bare token, or the token out of a pasted connect line. */
private fun newToken(text: String): String? {
    val t = text.trim()
    if (t.length == 64 && t.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return t
    return parseConnectLine(t)?.second
}

/** The dot, the state in a word or two, and what the server runs once it answers. */
@Composable
private fun StateLine(server: Server) {
    val store = LocalStore.current
    val w = store.connection(server.id)?.welcome
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StatusDot(server.id)
        Text(store.stateLabel(server.id), style = Dray.Font.body)
        if (server.on && store.serverState[server.id] == ConnState.Connected && w != null) {
            Text(if (w.macApp) "Dray ${w.version.orEmpty()}" else "dray ${w.release ?: w.version.orEmpty()}",
                style = Dray.Font.body.copy(color = Dray.tertiary), maxLines = 1)
        }
    }
}

/** What is wrong and its cure, else an update and its button; nothing when neither. */
@Composable
private fun StatusCard(id: String, scan: () -> Unit) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    var updating by remember(id) { mutableStateOf(false) }
    // Said in the card: the app's toast would be the only other place.
    var updateError by remember(id) { mutableStateOf<String?>(null) }
    val health = store.health(id)
    val w = store.connection(id)?.welcome
    val newer = Releases.newer(w)
    when {
        health != null -> StatusBox(health.title, health.needsYou, {
            health.detail?.let { Text(it) }
            health.until?.let { Text(countdown(it)) }
        }) {
            when {
                health.action == Health.Action.Fix && store.serverState[id] == ConnState.Failed(Problem.Auth) -> Pill("Scan QR code", onClick = scan)
                health.action == Health.Action.Retry -> Pill("Retry") { store.retry(id) }
            }
        }
        store.serverState[id] == ConnState.Connected && w != null && newer != null -> StatusBox("Update available", true, {
            if (w.macApp) Text("$newer is out. Update Dray on that Mac.")
            else {
                Text(if (updating) "Updating. It restarts once no turn is running." else "$newer is out. It restarts once no turn is running.")
                updateError?.let { Text(sentence(it), color = Dray.destructive) }
            }
        }) {
            if (!w.macApp) Pill("Update", enabled = !updating) {
                updating = true
                updateError = null
                // `update_server` on the server's own channel; it answers once the new binary is in, and restarts onto it when idle.
                val beta = w.release?.contains("-") == true
                scope.launch {
                    try {
                        val said = store.call(id, "update_server", jsonOf("channel" to if (beta) "beta" else "stable"), timeoutMs = 320_000)
                        if (said.str == "current") updating = false
                    } catch (e: Exception) {
                        updating = false
                        updateError = e.message ?: "Update failed"
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusBox(title: String, needsYou: Boolean, detail: @Composable () -> Unit, button: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.group)).background(Dray.card).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = Dray.Font.subhead.copy(color = if (needsYou) Dray.accent else Dray.text))
            androidx.compose.material3.ProvideTextStyle(Dray.Font.footnote.copy(color = Dray.secondary)) { detail() }
        }
        button()
    }
}

/**
 * The newest stable releases on GitHub, read as the desktop's `servers.rs` reads them: `cli-v`
 * tags for a `dray-serve`, `v` tags for Dray on a Mac.
 */
object Releases {
    var cli by mutableStateOf<String?>(null)
        private set
    var app by mutableStateOf<String?>(null)
        private set
    private var read = 0L

    /** At most hourly: unauthenticated, GitHub allows 60 reads an hour per address. */
    suspend fun refresh() {
        if (System.currentTimeMillis() - read < 3_600_000) return
        val tags = withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder().url("https://api.github.com/repos/monorepo-labs/dray/releases?per_page=100").build()
                http.newCall(request).execute().use { r ->
                    if (!r.isSuccessful) return@use null
                    wireJson.parseToJsonElement(r.body?.string() ?: return@use null).arr.mapNotNull { it["tag_name"].str }
                }
            }.getOrNull()
        } ?: return
        read = System.currentTimeMillis()
        cli = newest(tags, "cli-v")
        app = newest(tags, "v")
    }

    /** The newest stable tag under `prefix`: a prerelease's `-` past the prefix rules it out, not `cli-v`'s. */
    fun newest(tags: List<String>, prefix: String): String? =
        tags.filter { it.startsWith(prefix) && '-' !in it.removePrefix(prefix) }.map { it.removePrefix(prefix) }
            .maxWithOrNull(::compareVersions)

    /** The release a server is behind, or null: a local or dev build is never offered one. */
    fun newer(w: Welcome?): String? {
        w ?: return null
        val (running, newest) = if (w.macApp) w.version to app else w.release to cli
        if (running == null || newest == null || !behind(running, newest)) return null
        return newest
    }

    /** Whether `running` is older than the stable `newest`. A beta sorts below its own release. */
    fun behind(running: String, newest: String): Boolean {
        val base = running.substringBefore('-')
        val c = compareVersions(newest, base)
        return c > 0 || (c == 0 && base != running)
    }

    /** Numeric, part by part: 0.10.0 is past 0.9.3. */
    fun compareVersions(a: String, b: String): Int {
        val x = a.split('.').map { it.toIntOrNull() ?: 0 }
        val y = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val c = (x.getOrElse(i) { 0 }).compareTo(y.getOrElse(i) { 0 })
            if (c != 0) return c
        }
        return 0
    }
}
