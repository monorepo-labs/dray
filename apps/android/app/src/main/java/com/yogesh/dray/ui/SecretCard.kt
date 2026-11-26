package com.yogesh.dray.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.Item
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.store.Store
import com.yogesh.dray.wire.Bot
import com.yogesh.dray.wire.SecretAnswer
import com.yogesh.dray.wire.SecretRequest
import com.yogesh.dray.wire.SecretTask
import kotlinx.coroutines.launch

// SecretRequest.tsx and its lines in EventRow.tsx, restated for the phone. docs/secrets.md holds the rules.

/** Opens a chat from anywhere a line names one: a secret's task or bot. */
val LocalOpenSession = staticCompositionLocalOf<((SessionKey) -> Unit)?> { null }

/** Who a card or line names: a task or a bot, its face and name, and its machine where it runs elsewhere. */
data class SecretParty(val seed: String, val bot: Bot?, val title: String, val machine: String?, val key: SessionKey?)

private enum class Answer { Paste, Saved, Decline }

/** The card's buttons and field: one height, the item radius AskCard's rows use. */
private val CONTROL = 40.dp
private val controlShape = RoundedCornerShape(Dray.Radius.md)
private val fieldFill = Color.White.copy(alpha = 0.08f)

/**
 * An agent asking for a token or password with `dray secret request`. The value goes from this
 * field to the server answering, which writes it to an owner-only file and tells the agent the
 * path; it never enters the transcript. It lives in plain `remember`, never saved state, and is
 * cleared once sent.
 *
 * `asker` is set only where the card sits in someone else's chat — a bot's chat drawing its task's
 * ask — since in its own chat the asker is the chat.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SecretCard(key: SessionKey, request: SecretRequest, asker: SecretParty?, modifier: Modifier = Modifier) {
    val store = LocalStore.current
    val haptics = LocalHapticFeedback.current
    val uri = LocalUriHandler.current
    val scope = rememberCoroutineScope()
    val closest = request.closest
    val saved = request.savedNames
    var pasting by remember { mutableStateOf(closest == null) }
    var pick by remember { mutableStateOf(closest ?: saved.firstOrNull() ?: request.name) }
    var value by remember { mutableStateOf("") }
    var keep by remember { mutableStateOf(false) }
    var auto by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf<Answer?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf(false) }
    val busy = sending != null
    // Using it without asking keeps a pasted one, so Save reads as on while that is.
    val keeps = keep || auto
    val title = request.label ?: request.name

    fun send(answer: Answer) {
        val pasted = value.trim()
        if (busy || (answer == Answer.Paste && pasted.isEmpty())) return
        sending = answer
        error = null
        scope.launch {
            try {
                store.answerSecret(
                    key, request.requestId,
                    value = if (answer == Answer.Paste) pasted else null,
                    keep = answer == Answer.Paste && keeps,
                    useSaved = answer == Answer.Saved,
                    always = answer != Answer.Decline && auto,
                    from = if (answer == Answer.Saved) pick else null,
                )
                value = ""
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            } catch (e: Exception) {
                error = e.message ?: "Couldn't answer"
                sending = null
            }
        }
    }

    val decline = @Composable {
        // A 36dp target riding the title's 20dp line, so it moves nothing around it.
        Box(
            Modifier
                .rideLine(20.dp)
                .size(36.dp)
                .offset(x = 8.dp)
                .clip(CircleShape)
                .clickable(enabled = !busy) { send(Answer.Decline) }
                .semantics { contentDescription = "Decline" },
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.Close, null, Modifier.size(18.dp), tint = Dray.secondary) }
    }

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(Dray.Radius.group))
                .background(Dray.well)
                .border(1.dp, Dray.hairline, RoundedCornerShape(Dray.Radius.group))
                .padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                asker?.let { party ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val open = LocalOpenSession.current
                        Row(
                            Modifier.weight(1f).clip(RoundedCornerShape(6.dp))
                                .clickable(enabled = party.key != null && open != null) { party.key?.let { open?.invoke(it) } },
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            if (party.bot != null) BotFace(party.bot, 18.dp) else BotFace(party.seed, size = 18.dp)
                            Text(party.title, Modifier.weight(1f, fill = false), style = Dray.Font.subhead.copy(color = Dray.secondary), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            party.machine?.let { MachineMark(it) }
                        }
                        decline()
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.Top) {
                        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(Icons.Filled.Key, null, Modifier.padding(top = 2.dp).size(16.dp), tint = Dray.text)
                            Text(title, style = Dray.Font.subhead.copy(fontWeight = FontWeight.SemiBold))
                        }
                        if (asker == null) decline()
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        if (request.reason.isNotBlank()) Text(request.reason, style = Dray.Font.subhead.copy(color = Dray.secondary))
                        request.url?.let { url ->
                            // The system browser: the phone has no session browser for the agent to drive.
                            Row(
                                Modifier.clip(RoundedCornerShape(6.dp)).clickable { runCatching { uri.openUri(url) } },
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Icon(Icons.AutoMirrored.Filled.OpenInNew, null, Modifier.size(14.dp), tint = Dray.text)
                                Text(hostOf(url), Modifier.widthIn(max = 260.dp), style = Dray.Font.subhead, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (pasting) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (closest != null) Box(
                            // Its icon lines up with the card's text edge; no tooltip, as on the desktop.
                            Modifier.pullStart(10.dp).size(CONTROL).clip(CircleShape).clickable(enabled = !busy) { pasting = false }
                                .semantics { contentDescription = "Use saved" },
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.AutoMirrored.Filled.ArrowBack, null, Modifier.size(20.dp), tint = Dray.secondary) }
                        Box(
                            Modifier.weight(1f).height(CONTROL).clip(controlShape).background(fieldFill).padding(horizontal = 12.dp),
                            contentAlignment = Alignment.CenterStart,
                        ) {
                            if (value.isEmpty()) Text("Paste the value", style = Dray.Font.subhead.copy(color = Dray.tertiary), maxLines = 1)
                            BasicTextField(
                                value, { value = it; error = null },
                                Modifier.fillMaxWidth().semantics { contentDescription = title },
                                enabled = !busy,
                                singleLine = true,
                                textStyle = Dray.Font.subhead.copy(fontFamily = FontFamily.Monospace),
                                cursorBrush = SolidColor(Dray.text),
                                // A password keyboard learns nothing; no autofill hint, so no password manager offers to keep it.
                                visualTransformation = PasswordVisualTransformation(),
                                keyboardOptions = KeyboardOptions(
                                    capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
                                    keyboardType = KeyboardType.Password, imeAction = ImeAction.Send,
                                ),
                                keyboardActions = KeyboardActions(onSend = { send(Answer.Paste) }),
                            )
                        }
                        // Full strength while disabled, as Yogesh tuned it: the card's answer is always this.
                        FilledButton(
                            if (sending == Answer.Paste) "Sharing…" else "Share",
                            enabled = !busy && value.isNotBlank(),
                            icon = { Icon(Icons.Filled.VerifiedUser, null, Modifier.size(18.dp), tint = Dray.onPrimary) },
                        ) { send(Answer.Paste) }
                    }
                } else {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            val split = saved.size > 1
                            FilledButton(
                                buildAnnotatedString {
                                    append("Use saved ")
                                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(pick) }
                                },
                                enabled = !busy,
                                shape = if (split) RoundedCornerShape(topStart = Dray.Radius.md, bottomStart = Dray.Radius.md) else controlShape,
                                modifier = Modifier.widthIn(max = 240.dp),
                                icon = { Icon(Icons.Filled.Key, null, Modifier.size(16.dp), tint = Dray.onPrimary) },
                            ) { send(Answer.Saved) }
                            if (split) Box {
                                Box(
                                    Modifier.size(CONTROL).clip(RoundedCornerShape(topEnd = Dray.Radius.md, bottomEnd = Dray.Radius.md))
                                        .background(Dray.primary).clickable(enabled = !busy) { picking = true }
                                        .semantics { contentDescription = "Pick another saved secret" },
                                    contentAlignment = Alignment.Center,
                                ) { Icon(Icons.Filled.KeyboardArrowDown, null, Modifier.size(20.dp), tint = Dray.onPrimary) }
                                DropdownMenu(picking, { picking = false }, Modifier.widthIn(min = 220.dp), containerColor = Dray.raised) {
                                    Text(
                                        "Saved on ${store.name(key.server)}",
                                        Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                                        style = Dray.Font.footnote.copy(color = Dray.tertiary),
                                    )
                                    for (n in saved) DropdownMenuItem(
                                        text = { Text(n, style = Dray.Font.subhead.copy(fontFamily = FontFamily.Monospace)) },
                                        onClick = { pick = n; picking = false },
                                        leadingIcon = { Box(Modifier.width(18.dp)) { if (n == pick) Icon(Icons.Filled.Check, null, Modifier.size(18.dp), tint = Dray.text) } },
                                    )
                                }
                            }
                        }
                        Text(
                            "Paste a new one",
                            Modifier.height(CONTROL).clip(controlShape).clickable(enabled = !busy) { pasting = true }
                                .padding(horizontal = 12.dp).wrapLine(),
                            style = Dray.Font.subhead.copy(color = Dray.secondary),
                        )
                    }
                }

                Column {
                    if (pasting) SwitchLine("Save to Vault", keeps, enabled = !busy && !auto) { keep = it }
                    SwitchLine("Let agents use it without asking you", auto, enabled = !busy) { auto = it }
                }

                error?.let { Text(sentence(it), style = Dray.Font.footnote.copy(color = Dray.destructive)) }
            }
        }
        if (pasting) Text(lifeLine(keeps, request.task), Modifier.padding(horizontal = 16.dp), style = Dray.Font.footnote.copy(color = Dray.tertiary))
    }
}

/**
 * What happens to a pasted value, as the server does it: a file deleted after a day unless saved,
 * and a relayed task always gets that day-long copy on its own machine. "Out of chat and logs" and
 * no more: the agent can read the file, so it could still print it.
 */
private fun lifeLine(keeps: Boolean, task: SecretTask?): String {
    val out = "Kept out of chat and logs."
    if (task != null) return "$out On ${task.machine} for 24 hours."
    return if (keeps) "$out Saved on this machine." else "$out Deleted in 24 hours."
}

/** The card's light button. Disabled, it keeps its strength and only stops answering. */
@Composable
private fun FilledButton(
    label: Any,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    shape: RoundedCornerShape = controlShape,
    icon: @Composable () -> Unit,
    onClick: () -> Unit,
) {
    Row(
        modifier.height(CONTROL).clip(shape).background(Dray.primary).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        icon()
        val style = Dray.Font.pill.copy(color = Dray.onPrimary)
        when (label) {
            is androidx.compose.ui.text.AnnotatedString -> Text(label, style = style, maxLines = 1, overflow = TextOverflow.Ellipsis)
            else -> Text(label.toString(), style = style, maxLines = 1)
        }
    }
}

/** A switch with its words, the row the whole tap target. */
@Composable
private fun SwitchLine(label: String, on: Boolean, enabled: Boolean, set: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).clip(RoundedCornerShape(Dray.Radius.sm)).clickable(enabled = enabled) { set(!on) },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, Modifier.weight(1f), style = Dray.Font.subhead.copy(color = Dray.secondary))
        PickSwitch(on, enabled = enabled, set = set)
    }
}

/** The server glyph and name for a task on another machine than the chat's. */
@Composable
private fun MachineMark(machine: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        Icon(Icons.Outlined.Dns, null, Modifier.size(12.dp), tint = Dray.tertiary)
        Text(machine, style = Dray.Font.footnote.copy(color = Dray.tertiary), maxLines = 1)
    }
}

/** Measures whole but takes `line` of height, centred on it, so a larger target rides a text line. */
private fun Modifier.rideLine(line: Dp) = layout { measurable, constraints ->
    val p = measurable.measure(constraints.copy(minHeight = 0, maxHeight = androidx.compose.ui.unit.Constraints.Infinity))
    val h = line.roundToPx()
    layout(p.width, h) { p.place(0, (h - p.height) / 2) }
}

/** Draws `by` further toward the start and gives that room back, so what follows sits closer too. */
private fun Modifier.pullStart(by: Dp) = layout { measurable, constraints ->
    val p = measurable.measure(constraints)
    val pull = by.roundToPx()
    layout(p.width - pull, p.height) { p.placeRelative(-pull, 0) }
}

/** Centres a single-line text vertically inside a fixed height. */
private fun Modifier.wrapLine() = layout { measurable, constraints ->
    val p = measurable.measure(constraints.copy(minHeight = 0))
    val h = if (constraints.hasBoundedHeight) constraints.maxHeight else p.height
    layout(p.width, h) { p.place(0, (h - p.height) / 2) }
}

private fun hostOf(url: String): String = runCatching {
    val u = java.net.URI(url)
    val host = u.host ?: return@runCatching url
    host + (u.rawPath?.takeIf { it.isNotEmpty() && it != "/" } ?: "")
}.getOrDefault(url)

// Lines

/**
 * The task a relayed card answers, where the phone can reach it: the chat's server, or the shared
 * machine it runs on (MergeCardView's rule).
 */
fun Store.secretTaskKey(server: String, task: SecretTask): SessionKey? {
    val here = SessionKey(server, task.sessionId)
    if (items[here] != null) return here
    return servers.firstOrNull { it.via?.parent == server && (it.via.machine == task.machine || it.name == task.machine) }
        ?.let { SessionKey(it.id, task.sessionId) }
}

/** A relayed card's asker: the task on another machine. */
fun Store.secretTaskParty(server: String, task: SecretTask): SecretParty {
    val key = secretTaskKey(server, task)
    val title = key?.let { items[it]?.title }?.ifEmpty { null } ?: task.title.ifEmpty { "Task" }
    return SecretParty(task.sessionId, null, title, task.machine.ifEmpty { null }, key)
}

/** A hidden task's own card drawn in its bot's chat: the task, on the chat's machine. */
fun Store.secretSessionParty(key: SessionKey): SecretParty =
    SecretParty(key.id, null, items[key]?.title?.ifEmpty { null } ?: "Task", null, key)

/** The bot a task reports to, at any depth, on the task's own server. */
private fun Store.botAbove(key: SessionKey): SecretParty? {
    var at = items[key]?.parentSessionId
    repeat(8) {
        val id = at ?: return null
        val k = SessionKey(key.server, id)
        bot(k)?.let { return SecretParty(it.id, it, it.name, null, k) }
        at = items[k]?.parentSessionId?.takeIf { it != id }
    }
    return null
}

/** A secret line in a task's chat: a closed card, or an ask its bot's chat answers. */
@Composable
fun SecretItemLine(item: Item.Secret) {
    val store = LocalStore.current
    val key = LocalCallSession.current
    val answer = item.answer
    if (answer != null) {
        SecretAnswerLine(answer, key?.server)
        return
    }
    val name = item.askedName ?: return
    val bot = key?.let { store.botAbove(it) }
    SecretLine {
        Text("Asked", style = lineStyle)
        if (bot != null) PartyChip(bot) else Text("its bot", style = lineStyle)
        Text(nameWords("for ", name), style = lineStyle)
    }
}

/** "Saved NAME for 24 hours", "Used saved NAME", "Declined NAME", "Sent NAME to <task>": never the value or where it went. */
@Composable
fun SecretAnswerLine(answer: SecretAnswer, server: String?) {
    val store = LocalStore.current
    val party = answer.task?.let { t -> server?.let { store.secretTaskParty(it, t) } }
    SecretLine {
        val said = when {
            answer.outcome == "declined" -> nameWords("Declined ", answer.name, if (party != null) " for" else "")
            party != null -> nameWords("Sent ", answer.name, " to")
            answer.outcome == "used" -> nameWords("Used saved ", answer.name, if (answer.auto) " without asking" else "")
            else -> nameWords("Saved ", answer.name, if (answer.kept) " on this machine" else " for 24 hours")
        }
        Text(said, style = lineStyle)
        party?.let { PartyChip(it) }
    }
}

private val lineStyle get() = Dray.Font.subhead.copy(color = Dray.tertiary)

private fun nameWords(before: String, name: String, after: String = "") = buildAnnotatedString {
    append(before)
    withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(name) }
    append(after)
}

/** Opens on the card's own key, in the line's muted colour. */
@Composable
private fun SecretLine(content: @Composable RowScope.() -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(Icons.Filled.Key, null, Modifier.size(15.dp), tint = Dray.tertiary)
        content()
    }
}

/** Shrinks to its line rather than push the line's words off it. */
@Composable
private fun RowScope.PartyChip(party: SecretParty) {
    val open = LocalOpenSession.current
    Box(Modifier.weight(1f, fill = false)) {
        Chip(party.seed, party.bot, party.title, party.key?.takeIf { open != null }?.let { k -> { open!!(k) } })
    }
}
