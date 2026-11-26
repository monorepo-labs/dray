package com.yogesh.dray.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.parseDate
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.text.DateFormat
import java.util.Date

// SecretsSettings.tsx, restated: one machine's saved secrets at a time. A value goes in and never comes back out.

@Serializable
data class SecretSummary(val name: String, val modified: String = "", val always: Boolean = false)

private val NAME = Regex("^[A-Za-z_][A-Za-z0-9_]{0,63}$")

/** Settings › Vault: a machine picked at the top, its saved names, Auto per name, Replace and Delete. */
@Composable
fun SecretsSettings(back: () -> Unit) {
    val store = LocalStore.current
    val machines = store.live.filter { store.serverState[it.id] == ConnState.Connected }
    var picked by remember { mutableStateOf<String?>(null) }
    // A machine that went away takes the pick back to the first.
    val server = machines.firstOrNull { it.id == picked }?.id ?: machines.firstOrNull()?.id
    var secrets by remember(server) { mutableStateOf<List<SecretSummary>?>(null) }
    var error by remember(server) { mutableStateOf<String?>(null) }
    // The sheet open, adding where `target` is null and replacing it otherwise.
    var editing by remember { mutableStateOf(false) }
    var target by remember { mutableStateOf<SecretSummary?>(null) }
    var deleting by remember { mutableStateOf<SecretSummary?>(null) }
    var picking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(server, store.secretsRevision[server ?: ""]) {
        val s = server ?: return@LaunchedEffect
        runCatching { decodeList<SecretSummary>(store.call(s, "list_secrets")) }
            .onSuccess { secrets = it; error = null }
            .onFailure { error = it.message ?: "Couldn't read secrets" }
    }

    fun act(block: suspend () -> Unit) = scope.launch {
        runCatching { block() }.onFailure { error = it.message ?: "Couldn't change it" }
    }

    SettingsPage("Vault", back) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RowGroup {
                Box {
                    SettingsRow(
                        "Machine", icon = { Icon(Icons.Outlined.Dns, null, Modifier.size(20.dp), tint = Dray.secondary) },
                        value = server?.let { store.name(it) } ?: "None connected",
                        onClick = if (machines.size > 1) ({ picking = true }) else null,
                    )
                    DropdownMenu(picking, { picking = false }, Modifier.widthIn(min = 220.dp), offset = DpOffset(16.dp, 0.dp), containerColor = Dray.raised) {
                        for (m in machines) DropdownMenuItem(
                            text = { Text(m.name, style = Dray.Font.body, maxLines = 1) },
                            trailingIcon = if (m.id == server) ({ Icon(Icons.Filled.Check, "Chosen", Modifier.size(20.dp), tint = Dray.text) }) else null,
                            onClick = { picked = m.id; picking = false },
                        )
                    }
                }
                if (server != null) {
                    RowDivider()
                    SettingsRow("Add secret", icon = { Icon(Icons.Filled.Add, null, Modifier.size(20.dp), tint = Dray.secondary) }, trailing = false) {
                        target = null
                        editing = true
                    }
                }
            }
            GroupLabel("Saved on each machine. Values can't be read back.")
        }

        if (server != null) {
            val list = secrets
            when {
                error != null -> Text(sentence(error!!), Modifier.padding(horizontal = 12.dp), style = Dray.Font.subhead.copy(color = Dray.destructive))
                list == null -> {}
                list.isEmpty() -> Text("None saved yet.", Modifier.padding(horizontal = 12.dp), style = Dray.Font.subhead.copy(color = Dray.secondary))
                else -> RowGroup {
                    list.forEachIndexed { i, s ->
                        if (i > 0) RowDivider()
                        SecretRow(
                            s,
                            setAuto = { on -> act { store.call(server, "set_secret_always", jsonOf("name" to s.name, "on" to on)) } },
                            replace = { target = s; editing = true },
                            delete = { deleting = s },
                        )
                    }
                }
            }
        }
    }

    if (server != null && editing) SecretSheet(server, target, secrets.orEmpty()) { editing = false }
    deleting?.let { s ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            containerColor = Dray.card,
            title = { Text("Delete ${s.name}?", style = Dray.Font.headline) },
            text = { Text("Agents on ${server?.let { store.name(it) } ?: "this machine"} will have to ask for it again.", style = Dray.Font.subhead.copy(color = Dray.secondary)) },
            confirmButton = {
                TextButton({
                    deleting = null
                    server?.let { sv -> act { store.call(sv, "delete_secret", jsonOf("name" to s.name)) } }
                }) { Text("Delete", color = Dray.destructive) }
            },
            dismissButton = { TextButton({ deleting = null }) { Text("Cancel", color = Dray.secondary) } },
        )
    }
}

/** A saved name, when it was saved, Auto, and ⋯ for Replace and Delete. */
@Composable
private fun SecretRow(secret: SecretSummary, setAuto: (Boolean) -> Unit, replace: () -> Unit, delete: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(start = 16.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f).padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(secret.name, style = Dray.Font.body.copy(fontFamily = FontFamily.Monospace), maxLines = 1, overflow = TextOverflow.Ellipsis)
            savedOn(secret.modified)?.let { Text("Saved $it", style = Dray.Font.footnote.copy(color = Dray.tertiary), maxLines = 1) }
        }
        Text("Auto", style = Dray.Font.subhead.copy(color = Dray.secondary))
        PickSwitch(secret.always, set = setAuto)
        Box {
            IconButton({ menu = true }) { Icon(Icons.Filled.MoreHoriz, "${secret.name} options", tint = Dray.secondary) }
            DropdownMenu(menu, { menu = false }, Modifier.widthIn(min = 160.dp), containerColor = Dray.raised) {
                DropdownMenuItem(text = { Text("Replace", style = Dray.Font.body) }, onClick = { menu = false; replace() })
                DropdownMenuItem(text = { Text("Delete", style = Dray.Font.body.copy(color = Dray.destructive)) }, onClick = { menu = false; delete() })
            }
        }
    }
}

/**
 * Adds a secret, or replaces `secret`'s value with its name fixed. Auto is set after the value
 * lands, since the server only takes it for a saved name. The value is cleared once sent.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SecretSheet(server: String, secret: SecretSummary?, saved: List<SecretSummary>, close: () -> Unit) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    val replacing = secret != null
    var newName by remember { mutableStateOf("") }
    var value by remember { mutableStateOf("") }
    var auto by remember { mutableStateOf(secret?.always == true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val name = secret?.name ?: newName.trim()
    val nameOk = NAME.matches(name)
    // Adding under a saved name overwrites it, which the reader should know.
    val existing = saved.firstOrNull { it.name == name }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    fun submit() {
        val v = value.trim()
        if (!nameOk || v.isEmpty() || busy) return
        busy = true
        error = null
        scope.launch {
            try {
                store.call(server, "save_secret", jsonOf("name" to name, "value" to v))
                value = ""
                if (auto != (existing?.always == true)) store.call(server, "set_secret_always", jsonOf("name" to name, "on" to auto))
                close()
            } catch (e: Exception) {
                error = e.message ?: "Couldn't save it"
                busy = false
            }
        }
    }

    ModalBottomSheet({ if (!busy) close() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Dray.card) {
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 16.dp).navigationBarsPadding().imePadding(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(if (replacing) "Replace secret" else "Add secret", style = Dray.Font.headline)
                Text("Saved on ${store.name(server)}. Its value can't be read back.", style = Dray.Font.subhead.copy(color = Dray.secondary))
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                RowGroup {
                    SheetField("Name") {
                        if (replacing) Text(name, style = Dray.Font.body.copy(color = Dray.secondary, fontFamily = FontFamily.Monospace), maxLines = 1)
                        else SheetInput(newName, { newName = it }, "GITHUB_TOKEN", Modifier.focusRequester(focus), mono = true, enabled = !busy)
                    }
                    RowDivider()
                    SheetField("Value") {
                        SheetInput(
                            value, { value = it }, "Paste the value",
                            if (replacing) Modifier.focusRequester(focus) else Modifier, masked = true, enabled = !busy, done = ::submit,
                        )
                    }
                }
                val hint = when {
                    !replacing && newName.isNotBlank() && !nameOk -> "Letters, digits and _, like GITHUB_TOKEN."
                    !replacing && existing != null -> "$name is saved already; this replaces it."
                    else -> null
                }
                hint?.let { Text(it, Modifier.padding(horizontal = 12.dp), style = Dray.Font.footnote.copy(color = Dray.tertiary)) }
            }
            RowGroup {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(enabled = !busy) { auto = !auto }.padding(start = 16.dp, end = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Let agents use it without asking you", Modifier.weight(1f), style = Dray.Font.body)
                    PickSwitch(auto, enabled = !busy) { auto = it }
                }
            }
            error?.let { Text(sentence(it), Modifier.padding(horizontal = 4.dp), style = Dray.Font.footnote.copy(color = Dray.destructive)) }
            val ready = nameOk && value.isNotBlank() && !busy
            Text(
                if (busy) "Saving…" else if (replacing) "Replace" else "Save",
                Modifier.fillMaxWidth().height(50.dp).clip(CircleShape).background(Dray.primary).alpha(if (ready) 1f else 0.45f)
                    .clickable(enabled = ready, onClick = ::submit).padding(vertical = 14.dp),
                style = Dray.Font.headline.copy(color = Dray.onPrimary, textAlign = androidx.compose.ui.text.style.TextAlign.Center),
            )
        }
    }
}

/** A labelled line in the sheet's group: the label in a 72dp lane, the field beside it. */
@Composable
private fun SheetField(label: String, field: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, Modifier.width(72.dp), style = Dray.Font.body.copy(color = Dray.secondary))
        Box(Modifier.weight(1f)) { field() }
    }
}

@Composable
private fun SheetInput(
    value: String, change: (String) -> Unit, prompt: String, modifier: Modifier = Modifier,
    mono: Boolean = false, masked: Boolean = false, enabled: Boolean = true, done: () -> Unit = {},
) {
    if (value.isEmpty()) Text(prompt, style = Dray.Font.body.copy(color = Dray.tertiary), maxLines = 1)
    BasicTextField(
        value, change, modifier.fillMaxWidth(),
        enabled = enabled,
        singleLine = true,
        textStyle = Dray.Font.body.copy(fontFamily = if (mono || masked) FontFamily.Monospace else null),
        cursorBrush = SolidColor(Dray.text),
        // A password keyboard learns nothing, and with no autofill hint no password manager offers to keep it.
        visualTransformation = if (masked) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            capitalization = if (mono) KeyboardCapitalization.Characters else KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = if (masked) KeyboardType.Password else KeyboardType.Ascii,
            imeAction = if (masked) ImeAction.Done else ImeAction.Next,
        ),
        keyboardActions = KeyboardActions(onDone = { done() }),
    )
}

private fun savedOn(iso: String): String? = parseDate(iso)?.let { DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(it)) }
