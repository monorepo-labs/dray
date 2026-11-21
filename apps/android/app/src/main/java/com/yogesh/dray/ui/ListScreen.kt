package com.yogesh.dray.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.ListRow
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.Stage
import com.yogesh.dray.model.runsOn
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.wire.parseDate
import com.yogesh.dray.wire.shortAge
import kotlinx.coroutines.launch
import java.util.Calendar

private const val PAGE = 40

/** The merged list of every server's tasks: the desktop sidebar's runs, no title, no headings. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ListScreen(
    openSession: (SessionKey) -> Unit,
    openSettings: (String?) -> Unit,
    addServer: (scan: Boolean) -> Unit,
) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    var settled by rememberSaveable { mutableStateOf(false) }
    var project by rememberSaveable { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var shown by remember(settled, project) { mutableIntStateOf(PAGE) }
    val anyConnected = store.live.any { store.serverState[it.id] == ConnState.Connected }

    val names = store.live.flatMap { store.projects[it.id].orEmpty() }.map { it.name }.distinct().sorted()
    // A picked project that leaves the list is ignored rather than showing nothing.
    val filter = project?.takeIf { it in names }
    val hide = store.hideSessions
    val runs = if (hide) emptyList() else store.runs(filter, settled)
    val hasSettled = store.items.values.any { it.archived == true && it.hidden != true }
    val connected = store.live.count { store.serverState[it.id] == ConnState.Connected }

    // Read whatever the view, and again as servers come up: the Settled button shows only when there are some,
    // and an empty live list counts what was settled today.
    LaunchedEffect(settled, connected) { if (connected > 0) store.loadSettled() }

    Column(Modifier.fillMaxSize().background(Dray.page).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton({ openSettings(null) }) { Icon(Icons.Outlined.Settings, "Settings", tint = Dray.text) }
            Spacer(Modifier.weight(1f))
            if (!hide && (settled || (anyConnected && hasSettled))) {
                Row(
                    Modifier.padding(end = 8.dp).clip(CircleShape).background(Dray.raised)
                        .clickable { settled = !settled }.padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    CheckCheck(if (settled) Dray.text else Dray.secondary, 20.dp, 1.6f)
                    Text("Settled", style = Dray.Font.pill.copy(color = if (settled) Dray.text else Dray.secondary))
                }
            }
        }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch {
                    store.refresh()
                    if (settled) store.loadSettled()
                    refreshing = false
                }
            },
            modifier = Modifier.weight(1f),
        ) {
            val rows = runs.flatMap { it.rows }
            val empty = !settled && runs.isEmpty() && store.bots.values.all { it.isEmpty() }
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 12.dp, bottom = 120.dp)) {
                for (s in store.live) {
                    val h = store.health(s.id) ?: continue
                    if (store.serverState[s.id] != ConnState.Connected && !h.needsYou) continue
                    item("health-${s.id}") {
                        Box(Modifier.padding(start = 20.dp, end = 12.dp, bottom = 14.dp)) {
                            HealthBanner(h, retry = { store.retry(s.id) }, fix = { openSettings(s.id) })
                        }
                    }
                }
                if (!hide && names.size > 1 && (filter != null || rows.isNotEmpty())) {
                    item("projects") { ProjectStrip(names, filter) { project = it } }
                }
                if (settled && runs.isEmpty()) {
                    item("none") {
                        Text("Nothing settled.", Modifier.padding(start = 20.dp).height(44.dp), style = Dray.Font.subhead.copy(color = Dray.tertiary))
                    }
                }
                var left = shown
                runs.forEachIndexed { r, run ->
                    if (left <= 0) return@forEachIndexed
                    if (r > 0) item("gap-$r") { Spacer(Modifier.height(16.dp)) }
                    // A nest is never cut: the page runs on past rows hanging under one already shown.
                    var cut = run.rows.size
                    if (run.rows.size > left) {
                        cut = left
                        while (cut < run.rows.size && run.rows[cut].depth > 0) cut++
                    }
                    left -= cut
                    val rowsHere = run.rows.take(cut)
                    rowsHere.forEachIndexed { i, row ->
                        item(row.key.toString()) {
                            Box(Modifier.alpha(if (run.stage == Stage.Aside) 0.3f else 1f)) {
                                SessionRow(rowsHere, i) { openSession(row.key) }
                            }
                        }
                        if (!settled) store.asks[row.key]?.firstOrNull()?.let { ask ->
                            item("ask-${row.key}") {
                                AskCard(row.key, ask, Modifier.padding(start = 20.dp, top = 2.dp, end = 20.dp, bottom = 12.dp))
                            }
                        }
                    }
                }
                if (shown < rows.size) item("more") { LaunchedEffect(Unit) { shown += PAGE }; Spacer(Modifier.height(1.dp)) }
            }
            if (empty || (hide && store.bots.values.all { it.isEmpty() })) EmptyList(filter, addServer, openSettings)
        }
    }
}

@Composable
private fun ProjectStrip(names: List<String>, picked: String?, pick: (String?) -> Unit) {
    LazyRow(
        Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 12.dp),
        contentPadding = PaddingValues(horizontal = 20.dp),
        horizontalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item { Text("All", Modifier.clickable { pick(null) }, style = Dray.Font.body.copy(color = if (picked == null) Dray.text else Dray.tertiary)) }
        items(names) { n ->
            Text(n, Modifier.clickable { pick(n) }, style = Dray.Font.body.copy(color = if (picked == n) Dray.text else Dray.tertiary))
        }
    }
}

/** One task: its rail mark, the elbows hanging it under its parent, its PR glyph, title and what it is doing. */
@Composable
private fun SessionRow(rows: List<ListRow>, i: Int, onClick: () -> Unit) {
    val store = LocalStore.current
    val row = rows[i]
    val item = row.item
    val mark = store.prMark(row.key, item)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .clip(RoundedCornerShape(Dray.Radius.md))
            .clickable(onClick = onClick)
            .height(44.dp)
            .padding(end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(14.dp), contentAlignment = Alignment.Center) {
            val rail = when {
                store.isAsking(row.key) -> Dray.accent
                item.status == "completed" -> Dray.add
                else -> null
            }
            rail?.let { Box(Modifier.size(2.5.dp, 12.dp).clip(RoundedCornerShape(1.5.dp)).background(it)) }
        }
        for (level in 0 until row.depth) Elbow(own = level == row.depth - 1, runsOn = runsOn(rows, i, level))
        mark?.let { Box(Modifier.padding(end = 6.dp)) { PrGlyph(it) } }
        Text(
            item.title.ifEmpty { "Untitled" },
            Modifier.weight(1f),
            style = Dray.Font.body.copy(color = Dray.text.copy(alpha = 0.88f)),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Box(Modifier.widthIn(min = 36.dp), contentAlignment = Alignment.CenterEnd) {
            when {
                row.key.server in store.lost -> Icon(Icons.Outlined.WifiOff, "Server offline", Modifier.size(15.dp), tint = Dray.tertiary)
                mark?.state == "OPEN" && mark.checksState == "RUNNING" -> ChecksSpinner()
                item.busy -> Orb(OrbKind.Working, 16.dp)
                else -> parseDate(item.modified)?.let { Text(shortAge(it), style = Dray.Font.footnote.copy(color = Dray.tertiary)) }
            }
        }
    }
}

/** One level of a child's hang: a rail where a sibling still follows, and the curve into the row on its own level. */
@Composable
private fun Elbow(own: Boolean, runsOn: Boolean) {
    Canvas(Modifier.size(24.dp, 44.dp)) {
        val s = density
        val stroke = Stroke(1.2f * s, cap = StrokeCap.Round)
        if (runsOn) drawLine(Dray.connector, Offset(6 * s, 0f), Offset(6 * s, size.height), 1.2f * s, StrokeCap.Round)
        if (own) {
            val p = Path().apply {
                moveTo(6 * s, if (runsOn) 12 * s else 0f)
                lineTo(6 * s, 12 * s)
                quadraticTo(6 * s, 22 * s, 16 * s, 22 * s)
                lineTo(20 * s, 22 * s)
            }
            drawPath(p, Dray.connector, style = stroke)
        }
    }
}

/** An empty list is the whole screen: connect a server, connecting, can't reach, no tasks yet. */
@Composable
private fun EmptyList(filter: String?, addServer: (Boolean) -> Unit, openSettings: (String?) -> Unit) {
    val store = LocalStore.current
    val live = store.live
    val read = live.any { store.read(it.id) || store.known(it.id) }
    when {
        store.servers.isEmpty() -> EmptyScreen(EmptyArtKind.Connect, "Connect a server", "Pair with a machine running Dray.") {
            CapsuleButton("Scan QR code", light = true, icon = { Icon(Icons.Outlined.QrCodeScanner, null, tint = Dray.page) }) { addServer(true) }
            CapsuleButton("Enter an address") { addServer(false) }
        }
        live.isEmpty() -> EmptyScreen(EmptyArtKind.Connect, "Every server is off", "Turn one back on in Settings to see its tasks.") {
            CapsuleButton("Open Settings") { openSettings(null) }
        }
        live.none { store.serverState[it.id] == ConnState.Connected } || !read -> {
            val trouble = live.firstNotNullOfOrNull { s -> store.health(s.id)?.takeIf { !it.working }?.let { s to it } }
            when {
                live.all { store.serverState[it.id].let { s -> s == null || s == ConnState.Connecting(0) } } ->
                    EmptyScreen(EmptyArtKind.Connecting, "Connecting", live.joinToString(", ") { it.name })
                !store.online -> EmptyScreen(EmptyArtKind.Unreachable, "You're offline", "Tasks keep running on their servers.")
                trouble != null -> {
                    val (s, h) = trouble
                    val message = h.detail ?: (h.until?.let { "${countdown(it)}. " }.orEmpty() + "Check that it's awake and online.")
                    EmptyScreen(EmptyArtKind.Unreachable, h.title, message) {
                        if (h.action == Health.Action.Fix) CapsuleButton("Fix") { openSettings(s.id) }
                        else CapsuleButton("Retry now") { store.retry(s.id) }
                    }
                }
                else -> EmptyScreen(EmptyArtKind.Connecting, "Connecting", live.joinToString(", ") { it.name })
            }
        }
        else -> {
            val today = store.runs(filter, settled = true).flatMap { it.rows }.mapNotNull { r -> parseDate(r.item.modified)?.let { r to it } }
                .filter { isToday(it.second) }
            val last = today.maxByOrNull { it.second }
            when {
                store.hideSessions -> EmptyScreen(EmptyArtKind.Tasks, "No bots yet", "Make one from Dray on your computer.")
                last != null -> EmptyScreen({ SettledStack(last.first.item.title, shortAge(last.second)) }, "All clear",
                    if (today.size == 1) "1 settled today." else "${today.size} settled today.")
                filter != null -> EmptyScreen(EmptyArtKind.Project, "Nothing in $filter", "Start one from Dray on your computer.")
                else -> EmptyScreen(EmptyArtKind.Tasks, "No tasks yet", "Start one from Dray on your computer.")
            }
        }
    }
}

private fun isToday(ms: Long?): Boolean {
    ms ?: return false
    val a = Calendar.getInstance().apply { timeInMillis = ms }
    val b = Calendar.getInstance()
    return a.get(Calendar.YEAR) == b.get(Calendar.YEAR) && a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)
}

@Composable
fun CapsuleButton(label: String, light: Boolean = false, icon: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(50.dp)
            .clip(CircleShape)
            .background(if (light) Dray.text else Dray.raised)
            .clickable(onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon?.let { it(); Spacer(Modifier.width(8.dp)) }
        Text(label, style = Dray.Font.headline.copy(color = if (light) Dray.page else Dray.text))
    }
}

@Composable
fun EmptyScreen(art: EmptyArtKind, title: String, message: String, actions: (@Composable () -> Unit)? = null) =
    EmptyScreen({ EmptyArt(art) }, title, message, actions)

@Composable
fun EmptyScreen(art: @Composable () -> Unit, title: String, message: String, actions: (@Composable () -> Unit)? = null) {
    Column(
        Modifier.fillMaxSize().padding(horizontal = 40.dp).padding(bottom = 140.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        art()
        Spacer(Modifier.height(28.dp))
        Text(title, style = Dray.Font.title, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(message, Modifier.widthIn(max = 280.dp), style = Dray.Font.subhead.copy(color = Dray.secondary), textAlign = TextAlign.Center)
        actions?.let {
            Spacer(Modifier.height(28.dp))
            Column(Modifier.widthIn(max = 280.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) { it() }
        }
    }
}

enum class EmptyArtKind { Connect, Connecting, Unreachable, Tasks, Project }

/** The empty screens' drawing: a server block, a link to a stack of bars, in the iOS app's measures. */
@Composable
fun EmptyArt(kind: EmptyArtKind) {
    val t = rememberInfiniteTransition(label = "art")
    val head by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1600, easing = LinearEasing)), label = "head")
    Canvas(Modifier.size(180.dp, 120.dp)) {
        val s = density
        fun r(x: Float, y: Float, w: Float, h: Float, c: Color) = drawRect(c, Offset(x * s, y * s), Size(w * s, h * s))
        val link = Color(0xFFC3C5FF)
        r(0f, 30f, 30f, 60f, Color(0xFF1612F8))
        r(0f, 60f, 30f, 30f, Color(0xFF0C0C9E))
        val bars = when (kind) {
            EmptyArtKind.Tasks -> (0..8).map { 33f + it * 6 } + (0..8).map { 99f + it * 6 }
            EmptyArtKind.Project -> emptyList()
            else -> (0..9).map { 121f + it * 6 }
        }
        bars.forEachIndexed { i, x ->
            val lit = kind == EmptyArtKind.Connecting && i < 3
            r(x, 30f, 1.5f, 60f, if (lit) Color(0xFF4A46FF).copy(alpha = listOf(1f, 0.7f, 0.4f)[i]) else Dray.tile)
        }
        when (kind) {
            EmptyArtKind.Connect -> drawLine(link.copy(alpha = 0.6f), Offset(30 * s, 60 * s), Offset(120 * s, 60 * s), s,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(3 * s, 5 * s)))
            EmptyArtKind.Connecting -> {
                val x = 30 + 90 * head
                drawLine(link.copy(alpha = 0.8f), Offset(30 * s, 60 * s), Offset(x * s, 60 * s), s)
                drawLine(link.copy(alpha = 0.4f), Offset(x * s, 60 * s), Offset(120 * s, 60 * s), s,
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(3 * s, 5 * s), (x - 30) * s))
                r(x - 3, 57f, 6f, 6f, Color(0xFF2D29FF))
            }
            EmptyArtKind.Unreachable -> {
                drawLine(link, Offset(30 * s, 60 * s), Offset(66 * s, 60 * s), s)
                drawLine(link, Offset(94 * s, 60 * s), Offset(120 * s, 60 * s), s)
                drawLine(Dray.destructive, Offset(75 * s, 55 * s), Offset(85 * s, 65 * s), 1.5f * s, StrokeCap.Square)
                drawLine(Dray.destructive, Offset(85 * s, 55 * s), Offset(75 * s, 65 * s), 1.5f * s, StrokeCap.Square)
            }
            EmptyArtKind.Tasks, EmptyArtKind.Project -> {
                r(89.25f, 15f, 1.5f, 90f, Color(0xFF4A46FF))
                r(88f, 11f, 4f, 4f, Dray.text)
            }
        }
        if (kind != EmptyArtKind.Tasks && kind != EmptyArtKind.Project) {
            r(28f, 58f, 4f, 4f, Dray.text)
            r(118f, 58f, 4f, 4f, Dray.text)
        }
    }
}
