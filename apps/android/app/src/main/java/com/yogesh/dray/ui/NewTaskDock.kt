package com.yogesh.dray.ui

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.store.NEW_SESSION
import com.yogesh.dray.store.NewTask
import kotlinx.coroutines.launch

/** The app's one new task, so its picks and its bot aim outlive the list screen. */
val LocalNewTask = compositionLocalOf<NewTask> { error("No NewTask provided") }

/**
 * The foot of the list, as iOS has it: the voice orb, tapped to talk, and under it the picks a
 * new task starts on — model and effort, machine, project and "···" — each opening Run with. The
 * keyboard edits the words in a sheet, and a swipe up opens it. VoiceDock.swift.
 */
@Composable
fun NewTaskDock(started: (SessionKey) -> Unit, modifier: Modifier = Modifier) {
    val store = LocalStore.current
    val task = LocalNewTask.current
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    var picking by remember { mutableStateOf(false) }
    val server = task.server

    LaunchedEffect(server, task.harness) { task.load() }

    fun start() {
        scope.launch {
            val key = task.start()
            if (key != null) {
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                started(key)
            }
        }
    }

    VoiceDock(
        sending = task.sending,
        ready = task.ready,
        failure = task.failure?.let { "Couldn't start. ${sentence(it)}" },
        clearFailure = { task.failure = null },
        start = ::start,
        picks = { edit ->
            // Open while any machine is up: a draft pinned to one that went down still needs a way to move elsewhere.
            Picks(task, server?.let { store.name(it) }, edit) { if (task.connected.isNotEmpty()) picking = true }
        },
        // Dim while nothing is connected: the screen above says why.
        modifier = modifier.alpha(if (server == null) 0.3f else 1f),
        saveDraft = { scope.launch { task.saveDraft() } },
        draft = NEW_SESSION,
        discarded = task::forgetDraft,
    )

    if (picking) RunWithSheet(task) { picking = false }
}

/** Model and effort, machine, project and "···", each opening Run with. */
@Composable
private fun Picks(task: NewTask, machine: String?, edit: (() -> Unit)?, open: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(28.dp).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(Modifier.clickable(onClick = open), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            AgentMark(task.harness, 13.dp)
            Text(task.model?.label ?: if (task.modelId.isEmpty()) "Default" else task.modelId, style = Dray.Font.footnoteStrong, maxLines = 1)
            task.effort?.let { Text(Picks.effortLabels[it] ?: it, style = Dray.Font.footnote.copy(color = Dray.tertiary), maxLines = 1) }
        }
        // Machine before project: the project is one the machine holds. Either name gives way before the model's.
        Pick(Icons.Outlined.Dns, machine ?: "Machine", Modifier.weight(1f, fill = false), open)
        Pick(Icons.Filled.Folder, task.project ?: "Project", Modifier.weight(1f, fill = false), open)
        Icon(Icons.Filled.MoreHoriz, "More picks", Modifier.clip(CircleShape).clickable(onClick = open).padding(2.dp).size(20.dp), tint = Dray.secondary)
        edit?.let { Icon(Icons.Outlined.Keyboard, "Type", Modifier.clip(CircleShape).clickable(onClick = it).padding(2.dp).size(20.dp), tint = Dray.secondary) }
    }
}

@Composable
private fun Pick(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, modifier: Modifier, open: () -> Unit) {
    Row(modifier.clickable(onClick = open), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Icon(icon, null, Modifier.size(12.dp), tint = Dray.secondary)
        Text(label, style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun DockButton(fill: androidx.compose.ui.graphics.Color, label: String, enabled: Boolean = true, onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        Modifier.size(44.dp).clip(CircleShape).background(fill).clickable(enabled = enabled, onClickLabel = label, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { content() }
}
