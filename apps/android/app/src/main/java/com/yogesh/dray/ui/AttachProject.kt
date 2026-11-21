package com.yogesh.dray.ui

import android.content.ClipData
import android.content.ClipboardManager
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.GithubRepo
import com.yogesh.dray.wire.DrayError
import com.yogesh.dray.wire.Project
import com.yogesh.dray.wire.bool
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.str
import com.yogesh.dray.wire.wireJson
import kotlinx.coroutines.launch

/** Why the repo list can't be read: `no_cli`, `not_authenticated`, or anything else with its sentence. */
private data class Unavailable(val kind: String, val detail: String?)

/**
 * A GitHub repo cloned into `~/dray` on that server, or a folder already there; ATTACH-PLAN.md.
 * A repo already on the server attaches straight away. iOS's `AttachProjectView` in NewTask.swift.
 */
@Composable
fun AttachProject(server: String, projects: List<Project>, back: () -> Unit, attached: (List<Project>) -> Unit) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var repos by remember { mutableStateOf<List<GithubRepo>?>(null) }
    var unavailable by remember { mutableStateOf<Unavailable?>(null) }
    var loading by remember { mutableStateOf(false) }
    var stillMissing by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    // A repo not yet on the server, waiting on the reader to confirm the clone.
    var confirming by remember { mutableStateOf<GithubRepo?>(null) }
    var cloning by remember { mutableStateOf<String?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var typing by remember { mutableStateOf(false) }
    var path by remember { mutableStateOf("") }
    val place = store.name(server)
    val here = projects.map { it.path }.toSet()

    suspend fun read() {
        loading = true
        unavailable = null
        try {
            repos = decodeList(store.call(server, "github_repos"))
        } catch (e: Exception) {
            // A typed reason from gh arrives as `{"kind":…,"detail":…}`.
            val reason = (e as? DrayError)?.message?.let { runCatching { wireJson.parseToJsonElement(it) }.getOrNull() }
            unavailable = Unavailable(reason["kind"].str ?: "other", reason["detail"].str ?: e.message)
        }
        loading = false
    }

    fun attach(cmd: String, args: kotlinx.serialization.json.JsonObject) = scope.launch {
        failure = null
        try {
            // A clone runs as long as the repository is big; progress arrives meanwhile.
            attached(decodeList(store.call(server, cmd, args, timeoutMs = 1_800_000)))
        } catch (e: Exception) {
            failure = e.message
        }
        cloning = null
    }

    LaunchedEffect(server) { read() }

    PickSheet("Attach project", back = back) {
        // First, not under the repositories: a long list would bury it.
        PickCard {
            PickRow("Enter path", Modifier.alpha(if (cloning != null) 0.35f else 1f).clickable(enabled = cloning == null) { path = ""; typing = true }) {
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(20.dp), tint = Dray.tertiary)
            }
        }
        // Up here, where it is seen: under a long repository list it would land off screen.
        failure?.let { PickNote(sentence(it), Dray.destructive) }
        val u = unavailable
        when {
            u != null && (u.kind == "no_cli" || u.kind == "not_authenticated") -> {
                val command = if (u.kind == "no_cli") "dray setup" else "gh auth login"
                PickSection(null) {
                    PickCard {
                        Text(
                            if (u.kind == "no_cli") "Dray lists your repositories through GitHub's CLI, which is not on $place. Run this there:"
                            else "GitHub's CLI on $place is not logged in. Run this there:",
                            Modifier.padding(16.dp), style = Dray.Font.body,
                        )
                        PickDivider()
                        Row(Modifier.clickable {
                            context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("command", command))
                        }.rowFrame(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dray.Space.s)) {
                            Icon(Icons.Outlined.ContentCopy, null, Modifier.size(18.dp), tint = Dray.text)
                            Text(command, style = Dray.Font.code.copy(fontSize = Dray.Font.body.fontSize))
                        }
                        PickDivider()
                        PickRow(if (loading) "Looking…" else "Recheck", Modifier.clickable(enabled = !loading) {
                            scope.launch {
                                stillMissing = false
                                if (u.kind != "no_cli") return@launch read()
                                // Logging in changes nothing about where `gh` is, so that half only asks GitHub again.
                                val found = runCatching { store.call(server, "recheck_gh").bool }.getOrNull() == true
                                if (found) read() else stillMissing = true
                            }
                        }) {}
                    }
                    if (stillMissing) PickNote("Still no gh — Dray looks where your login shell looks.")
                }
            }
            u != null -> PickNote(sentence(u.detail ?: "Couldn't read repositories."), Dray.destructive)
            repos == null -> Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dray.Space.s)) {
                CircularProgressIndicator(Modifier.size(16.dp), color = Dray.secondary, strokeWidth = 2.dp)
                Text("Reading your repositories…", style = Dray.Font.body.copy(color = Dray.secondary))
            }
            else -> {
                SearchField(query) { query = it }
                val needle = query.trim().lowercase()
                val shown = repos.orEmpty().filter { needle.isEmpty() || needle in it.slug.lowercase() || it.description?.lowercase()?.contains(needle) == true }
                if (shown.isEmpty()) {
                    PickNote(if (repos.orEmpty().isEmpty()) "No repositories." else "No repository matches.")
                } else {
                    PickSection(null, footer = "Repositories not on $place yet clone into ~/dray there.") {
                        PickCard {
                            shown.forEachIndexed { i, r ->
                                if (i > 0) PickDivider()
                                RepoRow(r, r.path != null && r.path in here, cloning, store.cloneProgress[server]?.get(r.slug)) {
                                    // One already on the server attaches at once; a clone is too big to start on a stray tap.
                                    val p = r.path
                                    if (p != null) attach("add_project", jsonOf("path" to p)) else confirming = r
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    confirming?.let { r ->
        AlertDialog(
            { confirming = null },
            confirmButton = {
                TextButton({
                    confirming = null
                    cloning = r.slug
                    store.cloneProgress[server] = store.cloneProgress[server].orEmpty() - r.slug
                    attach("clone_github_repo", jsonOf("slug" to r.slug))
                }) { Text("Clone into ~/dray", style = Dray.Font.pill) }
            },
            dismissButton = { TextButton({ confirming = null }) { Text("Cancel", style = Dray.Font.pill.copy(color = Dray.secondary)) } },
            title = { Text("Clone ${r.slug}?", style = Dray.Font.headline) },
            text = { Text("It clones on $place, with gh.", style = Dray.Font.body.copy(color = Dray.secondary)) },
            containerColor = Dray.raised,
        )
    }
    if (typing) {
        AlertDialog(
            { typing = false },
            confirmButton = {
                TextButton({
                    typing = false
                    attach("add_project", jsonOf("path" to path.trim()))
                }, enabled = path.isNotBlank()) { Text("Attach", style = Dray.Font.pill.copy(color = if (path.isNotBlank()) Dray.text else Dray.tertiary)) }
            },
            dismissButton = { TextButton({ typing = false }) { Text("Cancel", style = Dray.Font.pill.copy(color = Dray.secondary)) } },
            title = { Text("Folder on $place", style = Dray.Font.headline) },
            text = { Field(path, "~/code/project") { path = it } },
            containerColor = Dray.raised,
        )
    }
}

@Composable
private fun RepoRow(r: GithubRepo, here: Boolean, cloning: String?, progress: String?, onClick: () -> Unit) {
    val mark = if (r.path == null) null else if (here) "Attached" else "Cloned"
    // Already a project here: nothing for Attach to do.
    val enabled = cloning == null && !here
    Row(
        Modifier.clickable(enabled = enabled, onClick = onClick).rowFrame().padding(vertical = 10.dp).alpha(if (enabled || cloning == r.slug) 1f else 0.5f),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Dray.Space.s),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row {
                Text(r.slug, Modifier.weight(1f), style = Dray.Font.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                mark?.let { Text(it, style = Dray.Font.footnote.copy(color = Dray.secondary)) }
            }
            val line = if (cloning == r.slug) progress ?: "Cloning…" else r.description
            line?.let {
                Text(it, style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = if (cloning == r.slug) 1 else 2, overflow = TextOverflow.Ellipsis)
            }
        }
        if (cloning == r.slug) CircularProgressIndicator(Modifier.size(16.dp), color = Dray.secondary, strokeWidth = 2.dp)
    }
}

@Composable
private fun SearchField(value: String, change: (String) -> Unit) {
    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.md)).background(Dray.raised).padding(horizontal = 14.dp, vertical = 10.dp)) {
        if (value.isEmpty()) Text("Search repositories", style = Dray.Font.body.copy(color = Dray.tertiary))
        BasicTextField(value, change, Modifier.fillMaxWidth(), textStyle = Dray.Font.body, singleLine = true, cursorBrush = SolidColor(Dray.text))
    }
}

@Composable
private fun Field(value: String, placeholder: String, change: (String) -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Box(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).clip(RoundedCornerShape(Dray.Radius.md)).background(Dray.card)
            .border(1.dp, Dray.hairline, RoundedCornerShape(Dray.Radius.md)).padding(horizontal = 12.dp, vertical = 11.dp),
    ) {
        if (value.isEmpty()) Text(placeholder, style = Dray.Font.body.copy(color = Dray.tertiary))
        BasicTextField(
            value, change, Modifier.fillMaxWidth().focusRequester(focus), textStyle = Dray.Font.body, singleLine = true, cursorBrush = SolidColor(Dray.text),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
        )
    }
}
