package com.yogesh.dray.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.toolArgument
import com.yogesh.dray.wire.AgentEvent
import com.yogesh.dray.wire.Payload
import com.yogesh.dray.wire.PermissionRequest
import com.yogesh.dray.wire.QuestionsRequest
import kotlinx.coroutines.launch

private val itemShape = RoundedCornerShape(Dray.Radius.md)
private fun itemFill(picked: Boolean) = Color.White.copy(alpha = if (picked) 0.2f else 0.08f)

/** A card the agent is stopped on, answered in place: a permission, or questions. */
@Composable
fun AskCard(key: SessionKey, event: AgentEvent, modifier: Modifier = Modifier) {
    // Keyed by the event, so a card's picks never carry over to the next one.
    key(event.id) {
        Box(modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.well).padding(12.dp)) {
            when (val p = event.payload) {
                is Payload.PermissionRequested -> PermissionCard(key, p.request)
                is Payload.QuestionsAsked -> QuestionsCard(key, p.request)
                else -> {}
            }
        }
    }
}

@Composable
private fun PermissionCard(key: SessionKey, request: PermissionRequest) {
    val store = LocalStore.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    val argument = toolArgument(request.input)
    val beside = request.description ?: argument
    Column(Modifier.alpha(if (busy) 0.6f else 1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Column(Modifier.padding(start = 2.dp, top = 2.dp, end = 2.dp, bottom = 4.dp)) {
            Text(
                buildAnnotatedString {
                    append(request.displayName ?: request.toolName)
                    beside?.let { withStyle(SpanStyle(color = Dray.text.copy(alpha = 0.5f))) { append(" $it") } }
                },
                style = Dray.Font.subhead,
                maxLines = 3,
            )
            if (argument != null && argument != beside) {
                Text(argument, style = Dray.Font.footnote.copy(color = Dray.tertiary), maxLines = 4)
            }
        }
        for (option in request.options) {
            Text(
                option.label,
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 40.dp)
                    .clip(itemShape)
                    .background(itemFill(false))
                    .clickable(enabled = !busy) {
                        busy = true
                        scope.launch {
                            if (store.respond(key, request.requestId, option.id)) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            busy = false
                        }
                    }
                    .padding(horizontal = 12.dp, vertical = 9.dp),
                style = Dray.Font.body.copy(color = if (option.behavior == "deny") Dray.destructive else Dray.text),
            )
        }
    }
}

/** One question at a time; answers go back keyed by each question's own text, which is how the CLI matches them. */
@Composable
private fun QuestionsCard(key: SessionKey, request: QuestionsRequest) {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    var index by remember { mutableIntStateOf(0) }
    val picks = remember { mutableStateMapOf<Int, Set<String>>() }
    val typed = remember { mutableStateMapOf<Int, String>() }
    var busy by remember { mutableStateOf(false) }

    val haptics = LocalHapticFeedback.current

    fun send() {
        if (busy) return
        val answers = mutableMapOf<String, String>()
        request.questions.forEachIndexed { i, q ->
            val text = typed[i]?.trim().orEmpty()
            val typedAnswer = if (text.isNotEmpty() && q.freeText != false) listOf(text) else emptyList()
            // In option order, so the answer reads the way the menu did; typed text last.
            val picked = q.options.map { it.label }.filter { it in picks[i].orEmpty() }
            val parts = if (q.multiSelect) picked + typedAnswer else typedAnswer.ifEmpty { picked }
            if (parts.isNotEmpty()) answers[q.question] = parts.joinToString(", ")
        }
        busy = true
        scope.launch {
            if (store.answer(key, request.requestId, answers)) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            busy = false
        }
    }

    if (request.questions.isEmpty()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("The agent asked nothing.", Modifier.weight(1f), style = Dray.Font.subhead.copy(color = Dray.secondary))
            Text("Skip", Modifier.clickable { send() }, style = Dray.Font.subhead.copy(color = Color.White.copy(alpha = 0.5f)))
        }
        return
    }
    val q = request.questions[index.coerceIn(0, request.questions.lastIndex)]
    val last = index >= request.questions.lastIndex
    Column(Modifier.alpha(if (busy) 0.6f else 1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.padding(2.dp)) {
            Text(q.question, Modifier.weight(1f), style = Dray.Font.subhead)
            if (request.questions.size > 1) Text("${index + 1} of ${request.questions.size}", style = Dray.Font.footnote.copy(color = Color.White.copy(alpha = 0.3f)))
        }
        for (option in q.options) {
            val picked = option.label in picks[index].orEmpty()
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(itemShape)
                    .background(itemFill(picked))
                    .clickable(enabled = !busy) {
                        val now = picks[index].orEmpty()
                        if (q.multiSelect) {
                            picks[index] = if (picked) now - option.label else now + option.label
                        } else {
                            // A pick is the answer, which typed text would otherwise outrank unseen; a second tap lets it go.
                            picks[index] = if (picked) emptySet() else setOf(option.label)
                            typed[index] = ""
                        }
                    }
                    .padding(horizontal = 12.dp, vertical = 9.dp),
            ) {
                Text(option.label, style = Dray.Font.body)
                option.description?.let { Text(it, style = Dray.Font.footnote.copy(color = Color.White.copy(alpha = 0.4f))) }
            }
        }
        if (q.freeText != false) {
            val value = typed[index].orEmpty()
            Box(Modifier.fillMaxWidth().heightIn(min = 40.dp).clip(itemShape).background(itemFill(value.isNotEmpty())).padding(horizontal = 12.dp, vertical = 9.dp)) {
                if (value.isEmpty()) Text("Something else…", style = Dray.Font.body.copy(color = Color.White.copy(alpha = 0.3f)))
                BasicTextField(
                    value,
                    {
                        typed[index] = it
                        // Typing on a single-select stands in for a pick.
                        if (!q.multiSelect && it.isNotEmpty()) picks[index] = emptySet()
                    },
                    Modifier.fillMaxWidth(),
                    textStyle = Dray.Font.body,
                    cursorBrush = SolidColor(Dray.text),
                )
            }
        }
        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
            if (index > 0) Text("Back", Modifier.clickable(enabled = !busy) { index-- }, style = Dray.Font.subhead.copy(color = Color.White.copy(alpha = 0.5f)))
            Spacer(Modifier.weight(1f))
            Text("Skip", Modifier.clickable(enabled = !busy) {
                picks.remove(index); typed.remove(index)
                if (last) send() else index++
            }, style = Dray.Font.subhead.copy(color = Color.White.copy(alpha = 0.5f)))
            Text(
                if (last) "Send" else "Next",
                Modifier
                    .height(34.dp)
                    .clip(CircleShape)
                    .background(Color.White)
                    .clickable(enabled = !busy) { if (last) send() else index++ }
                    .padding(horizontal = 16.dp, vertical = 7.dp),
                style = Dray.Font.pill.copy(color = Color.Black),
            )
        }
    }
}
