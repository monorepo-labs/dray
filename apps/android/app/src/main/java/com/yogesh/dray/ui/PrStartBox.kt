package com.yogesh.dray.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.PullRequest
import com.yogesh.dray.model.PullRow
import com.yogesh.dray.model.prInitial
import com.yogesh.dray.model.prMachines
import com.yogesh.dray.model.prPrompt
import com.yogesh.dray.model.prRepoSlug
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.jsonOf
import java.util.UUID

// PullDetail.swift's `PrStartBox`: a task for the PR, the reader's own or a bot's, on the PR's own branch.

/**
 * A task for the PR on a new worktree of its own branch, the reader's or a bot's on the machine
 * the PR was read through. Always Auto: the page offers no stance.
 */
@Composable
fun PrStartBox(row: PullRow, pr: PullRequest, text: String, setText: (String) -> Unit, latest: SessionItem?, started: () -> Unit) {
    val store = LocalStore.current
    if (row.listing.isCrossRepository) {
        Text("Read only. This branch lives in a fork, so an agent here can't push to it.", style = Dray.Font.subhead.copy(color = Dray.secondary))
        return
    }
    val connected = store.live.filter { store.serverState[it.id] == ConnState.Connected }.map { it.id }
    val machines = prMachines(row, connected) { store.projects[it].orEmpty() }
    val initial = prInitial(row, machines)
    StartBox(
        prefsKey = "pr", text = text, setText = setText,
        placeholder = "What should the agent do with this pull request?",
        placeLabel = "Machine",
        machines = machines, initial = if (machines.isEmpty()) null else initial,
        clone = (if (row.key.startsWith("github:")) row.key.removePrefix("github:") else prRepoSlug(row.mark.url).orEmpty()) to row.repo,
        bots = store.bots[initial.server].orEmpty().map { initial.server to it },
        botCheckout = true,
        latest = latest,
        worktreeSwitch = false,
        note = {
            Row(Modifier.padding(horizontal = Dray.Space.xs), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.AutoMirrored.Filled.CallSplit, null, Modifier.size(14.dp), tint = Dray.secondary)
                Text(buildAnnotatedString {
                    append("New worktree on ")
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = Dray.text)) { append(row.mark.headRefName) }
                    append(", the PR's own branch")
                }, style = Dray.Font.footnote.copy(color = Dray.secondary), maxLines = 2)
            }
        },
        run = { p ->
            val item = try {
                decodeOrNull<SessionItem>(store.call(p.server, "start_pr_session", jsonOf(
                    "sessionId" to UUID.randomUUID().toString().lowercase(),
                    "prompt" to prPrompt(pr, p.text),
                    "harness" to p.harness, "model" to p.model, "effort" to p.effort,
                    "permissionMode" to "auto", "fast" to p.fast, "cwd" to p.cwd,
                    "prHead" to mapOf("branch" to row.mark.headRefName, "repo" to row.repo),
                    "prNumber" to row.mark.number, "bot" to p.bot?.id,
                ), timeoutMs = 120_000))
            } catch (e: Exception) {
                // Asked before anything is made, so nothing is left to tidy up.
                if (e.message?.contains("unknown command") == true) throw IllegalStateException("This server is older than the pull requests page. Update it, then start the task again.")
                throw e
            }
            item?.let { store.created(p.server, it) }
        },
        started = { started() },
    )
}
