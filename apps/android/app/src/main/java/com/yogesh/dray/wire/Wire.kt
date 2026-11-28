package com.yogesh.dray.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.OffsetDateTime
import java.util.concurrent.ConcurrentHashMap

/** The server protocol version this build speaks; `serve.rs`'s `PROTOCOL`. */
const val SERVE_PROTOCOL = 1

private val parsedDates = ConcurrentHashMap<String, Long>()

/** Epoch millis of an RFC3339 stamp, cached: the list re-sorts every session's stamps on each redraw. */
fun parseDate(s: String?): Long? {
    if (s == null) return null
    parsedDates[s]?.let { return it }
    val ms = runCatching { OffsetDateTime.parse(s).toInstant().toEpochMilli() }
        .recoverCatching { Instant.parse(s).toEpochMilli() }.getOrNull() ?: return null
    parsedDates[s] = ms
    return ms
}

/** How long ago, as the sidebar says it: now, 4m, 1h, 3d. */
fun shortAge(ms: Long, now: Long = System.currentTimeMillis()): String {
    val s = (now - ms) / 1000
    return when {
        s < 60 -> "now"
        s < 3600 -> "${s / 60}m"
        s < 86400 -> "${s / 3600}h"
        else -> "${s / 86400}d"
    }
}

/** The server's first frame: what it can do and what it runs. */
@Serializable
data class Welcome(
    val dictation: Boolean? = null,
    val version: String? = null,
    val release: String? = null,
    val dev: Boolean? = null,
    /** A hash of the server's token, so one machine reached two ways is one (`serverId`). */
    val identity: String? = null,
) {
    /** Dray on a Mac, whose server follows the app's own updates. */
    val macApp: Boolean get() = dictation == true && release == null && dev != true
}

@Serializable
data class Need(val text: String, val at: String)

/** One index entry. Fields the phone does not read are left undecoded, so a newer server adding some costs nothing. */
@Serializable
data class SessionItem(
    val sessionId: String,
    val harness: String = "claude_code",
    val cwd: String = "",
    val projectPath: String = "",
    val title: String = "",
    val model: String = "",
    val effort: String? = null,
    val permissionMode: String = "auto",
    val fast: Boolean? = null,
    val status: String = "idle",
    val modified: String = "",
    val archived: Boolean? = null,
    val branch: String? = null,
    val worktreeName: String? = null,
    val worktreeRemoved: Boolean? = null,
    val hidden: Boolean? = null,
    val pinned: Boolean? = null,
    /** Set aside by the reader: started, not wanted now. */
    val aside: Boolean? = null,
    val parentSessionId: String? = null,
    val created: String? = null,
    val need: Need? = null,
    val adoptedBy: String? = null,
    val routineRun: String? = null,
    /** A lazy fork the CLI has not carried out yet: it has run no turn, so there is nothing to mark unread. */
    val forkFrom: String? = null,
    /** Issues the task was started on or tagged with. */
    val issues: List<IssueLink> = emptyList(),
) {
    val busy: Boolean get() = status == "in_progress"
    val project: String get() = projectPath.trimEnd('/').substringAfterLast('/')
}

/** An issue on a session's index entry, the server's `IssueRef`. */
@Serializable
data class IssueLink(val tracker: String = "", val id: String = "", val identifier: String = "", val title: String = "", val url: String = "")

/** A bot, as `list_bots` answers it. Its chat is any session whose `cwd` is `path`. */
@Serializable
data class Bot(
    val id: String,
    val name: String,
    val path: String,
    val avatar: JsonElement? = null,
    val welcome: String? = null,
    val greeting: List<String>? = null,
    /** Its place in the bot list, set by dragging on the desktop. None on a new bot or an older server. */
    val order: Long? = null,
)

/** One branch's pull request, as `pr_marks` answers it. `checksState` is `RUNNING`, `FAILING` or `CLEAR`. */
@Serializable
data class PrMark(
    val number: Int,
    val headRefName: String,
    val isDraft: Boolean = false,
    val state: String,
    val checksState: String = "CLEAR",
    val url: String? = null,
    val mergeable: String? = null,
    val mergeStateStatus: String? = null,
    val reviewDecision: String? = null,
    /** What a row on the pull requests page draws; only where the read asked for it. */
    val listing: PrListing? = null,
)

/** `github.rs`'s `PrListing`. */
@Serializable
data class PrListing(
    val title: String = "",
    val author: String = "",
    val authorAvatar: String? = null,
    val updatedAt: String = "",
    val additions: Int = 0,
    val deletions: Int = 0,
    val commentCount: Int = 0,
    val isCrossRepository: Boolean = false,
    val viewerDidAuthor: Boolean = false,
    val reviewRequested: Boolean = false,
)

@Serializable
data class Project(
    val path: String,
    val name: String,
    val lastSelected: String = "",
    val remote: String? = null,
    val space: String? = null,
)

/** What `share_machines` answers and `machines_shared` carries (#847). */
@Serializable
data class Sharing(val on: Boolean = false, val machines: List<Machine> = emptyList()) {
    @Serializable
    data class Machine(val id: String, val name: String)
}

@Serializable
data class StatusEvent(val sessionId: String, val status: String, val modified: String? = null)

@Serializable
data class TitleEvent(val sessionId: String, val title: String)

/** `session_deleted`: another client deleted a session. */
@Serializable
data class DeletedEvent(val sessionId: String)

@Serializable
data class Queued(val id: String, val text: String, val attachmentPaths: List<String> = emptyList())

@Serializable
data class QueueChanged(val sessionId: String, val queued: List<Queued> = emptyList())

/** `session_serving`: the ports a session's background shells serve, where that is all its background work is. */
@Serializable
data class ServingEvent(val sessionId: String, val ports: List<Int> = emptyList())

@Serializable
data class BackgroundTask(val taskId: String, val taskType: String? = null, val description: String? = null)

/** A picture on a prompt or a tool result. `path` is the archived copy, read through the server's `/file`. */
@Serializable
data class ImageRef(val path: String? = null, val url: String? = null, val mimeType: String? = null)

@Serializable
data class PermissionOption(val id: String, val label: String, val behavior: String = "allow", val kind: String? = null)

@Serializable
data class PermissionRequest(
    val requestId: String,
    val toolName: String = "",
    val displayName: String? = null,
    val title: String? = null,
    val description: String? = null,
    val input: JsonElement? = null,
    val options: List<PermissionOption> = emptyList(),
)

@Serializable
data class QuestionOption(val label: String, val description: String? = null)

@Serializable
data class Question(
    val question: String,
    val header: String? = null,
    val multiSelect: Boolean = false,
    val options: List<QuestionOption> = emptyList(),
    /** False on pi's select and confirm, which take an offered option or nothing. */
    val freeText: Boolean? = null,
)

@Serializable
data class QuestionsRequest(val requestId: String, val questions: List<Question> = emptyList())

/** The task on another machine a bot's secret card answers: `events.rs`'s `SecretTask`. */
@Serializable
data class SecretTask(
    val sessionId: String,
    val title: String = "",
    val machine: String = "",
    val machineId: String? = null,
    val requestId: String? = null,
)

/**
 * `dray secret request`'s card. `bot` marks the task's own line for an ask its bot's chat on another
 * machine answers; `task` is set on that bot's side. Logged, and closed only by its `secret_answered`.
 */
@Serializable
data class SecretRequest(
    val requestId: String,
    val name: String,
    val label: String? = null,
    val reason: String = "",
    val url: String? = null,
    val savedNames: List<String> = emptyList(),
    val closest: String? = null,
    val bot: Boolean = false,
    val task: SecretTask? = null,
)

/** How a secret card closed, never the value. `replaced` and `withdrawn` draw nothing: the newer card is the row, or the agent took it back. */
@Serializable
data class SecretAnswer(
    val requestId: String,
    val name: String,
    val outcome: String,
    val kept: Boolean = false,
    val auto: Boolean = false,
    val task: SecretTask? = null,
) {
    val draws: Boolean get() = outcome == "saved" || outcome == "declined" || outcome == "used"
}

data class ToolResult(val text: String, val isError: Boolean, val images: List<ImageRef>, val cut: Boolean)

/** Whether a call's `input`, or its result's `structured`, was cut by the server: thin.rs's `CUT` mark. */
fun isCut(value: JsonElement?): Boolean = value["_cut"].bool == true

private fun images(o: JsonObject): List<ImageRef> = decodeList(o["images"])

sealed interface Payload {
    data class TurnCompleted(val failed: Boolean, val finalText: String?) : Payload
    /** `queued` is a prompt typed into a running turn; `kickoff` is Dray's own prompt, drawn as nothing. */
    data class UserMessage(
        val text: String, val fromTitle: String?, val fromId: String?, val queued: Boolean,
        val images: List<ImageRef>, val kickoff: Boolean, val fromBot: String?,
    ) : Payload
    data class AssistantText(val text: String) : Payload
    data class ToolStarted(val callId: String, val name: String, val toolType: String, val input: JsonElement, val title: String?) : Payload
    data class ToolCompleted(val callId: String, val result: ToolResult) : Payload
    data class PermissionRequested(val request: PermissionRequest) : Payload
    data class QuestionsAsked(val request: QuestionsRequest) : Payload
    data class PermissionDecided(val requestId: String) : Payload
    data class SecretRequested(val request: SecretRequest) : Payload
    data class SecretAnswered(val answer: SecretAnswer) : Payload
    data class BackgroundTasks(val tasks: List<BackgroundTask>) : Payload
    /** A subagent or backgrounded shell's lifecycle; which run is on the event's `subagent`. */
    data class SubagentStarted(val agentId: String, val label: String?, val description: String?) : Payload
    data class SubagentProgress(val agentId: String, val description: String?) : Payload
    data class SubagentCompleted(val agentId: String) : Payload
    data class Error(val message: String) : Payload
    /** `dray session merge-card`'s card in a bot's chat. */
    data class MergeCardPosted(val card: MergeCard) : Payload
    /** `dray session issue-card`'s card in a chat. */
    data class IssueCardPosted(val card: IssueCard) : Payload
    /** The reader handed issue `number` of card `cardId` to the agent: drawn on its tile as started. */
    data class IssueApproved(val cardId: String, val number: Int) : Payload
    /** A task a bot started, which the server logs in the bot's chat. */
    data class TaskStarted(val taskId: String, val title: String?) : Payload
    data class Learned(val commit: String, val files: List<Lesson>) : Payload
    data class LearnedUndone(val commit: String, val path: String) : Payload
    /** An emoji on a message: a bot's on the reader's, or with `byUser` the reader's on the agent's. */
    data class Reaction(val messageId: String, val emoji: String, val byUser: Boolean = false) : Payload
    /** A task moved to another agent (#1417), wherever it was picked. Draws nothing. */
    data class AgentSwitched(val from: String?, val to: String) : Payload
    data class Other(val type: String) : Payload

    /** Superseded or running counters the server never logs either. */
    val isTransient: Boolean get() = this is Other && type in setOf("delta", "usage_update", "model_request_started", "repo_changed")

    val askId: String?
        get() = when (this) {
            is PermissionRequested -> request.requestId
            is QuestionsAsked -> request.requestId
            is SecretRequested -> request.requestId
            else -> null
        }

    companion object {
        /** A payload whose shape moved decodes as `Other` rather than failing the event, and with it its whole list. */
        fun decode(o: JsonObject?): Payload {
            val type = o["type"].str ?: "unknown"
            if (o == null) return Other(type)
            return runCatching { decodeTyped(type, o) }.getOrNull() ?: Other(type)
        }

        private fun decodeTyped(type: String, o: JsonObject): Payload? { return when (type) {
            "turn_completed" -> {
                // A user's Stop ends a turn as `error` too; the desktop's `drawsFailure` rule.
                val stop = o["stopReason"].str ?: ""
                TurnCompleted(o["status"].str == "error" && !stop.startsWith("aborted"), o["finalText"].str)
            }
            "user_message" -> {
                val from = o["from"].obj
                UserMessage(
                    text = o["text"].str ?: return null,
                    fromTitle = from["title"].str, fromId = from["sessionId"].str,
                    queued = o["queued"].bool ?: false, images = images(o),
                    kickoff = o["kickoff"].bool ?: false, fromBot = from["botId"].str,
                )
            }
            "assistant_text" -> AssistantText(o["text"].str ?: return null)
            "tool_call_started" -> ToolStarted(
                callId = o["callId"].str ?: return null, name = o["name"].str ?: return null,
                toolType = o["toolType"].str ?: "other", input = o["input"] ?: JsonNull, title = o["title"].str,
            )
            "tool_call_completed" -> {
                val r = o["result"].obj ?: return null
                ToolCompleted(
                    o["callId"].str ?: return null,
                    ToolResult(r["text"].str ?: "", r["isError"].bool ?: false, images(r), isCut(r["structured"])),
                )
            }
            "permission_requested" -> PermissionRequested(wireJson.decodeFromJsonElement(PermissionRequest.serializer(), o))
            "questions_asked" -> QuestionsAsked(wireJson.decodeFromJsonElement(QuestionsRequest.serializer(), o))
            "permission_decided" -> PermissionDecided(o["requestId"].str ?: return null)
            "secret_requested" -> SecretRequested(wireJson.decodeFromJsonElement(SecretRequest.serializer(), o))
            "secret_answered" -> SecretAnswered(wireJson.decodeFromJsonElement(SecretAnswer.serializer(), o))
            "background_tasks_changed" -> BackgroundTasks(decodeList(o["tasks"]))
            "subagent_started" -> SubagentStarted(o["agentId"].str ?: "", o["label"].str, o["description"].str)
            "subagent_progress" -> SubagentProgress(o["agentId"].str ?: "", o["description"].str)
            "subagent_completed" -> SubagentCompleted(o["agentId"].str ?: "")
            "error" -> Error(o["message"].str ?: return null)
            "merge_card" -> MergeCardPosted(wireJson.decodeFromJsonElement(MergeCard.serializer(), o))
            "issue_card" -> IssueCardPosted(wireJson.decodeFromJsonElement(IssueCard.serializer(), o))
            "issue_approved" -> IssueApproved(o["cardId"].str ?: return null, o["number"].int ?: return null)
            "task_started" -> TaskStarted(o["taskId"].str ?: return null, o["title"].str)
            "learned" -> Learned(o["commit"].str ?: return null, decodeList(o["files"]))
            "learned_undone" -> LearnedUndone(o["commit"].str ?: return null, o["path"].str ?: return null)
            "reaction" -> Reaction(o["messageId"].str ?: return null, o["emoji"].str ?: return null, o["byUser"].bool ?: false)
            "agent_switched" -> AgentSwitched(o["from"].str, o["to"].str ?: return null)
            else -> Other(type)
        } }
    }
}

data class AgentEvent(
    val id: String,
    val sessionId: String,
    val ts: String?,
    val harness: String?,
    /** Set on a subagent's own events, which the chat does not draw. */
    val subagent: JsonElement?,
    val payload: Payload,
) {
    companion object {
        fun decode(e: JsonElement?): AgentEvent? {
            val o = e.obj ?: return null
            return AgentEvent(
                id = o["id"].str ?: return null,
                sessionId = o["sessionId"].str ?: return null,
                ts = o["ts"].str,
                harness = o["harness"].str,
                subagent = o["subagent"],
                payload = Payload.decode(o["payload"].obj),
            )
        }

        fun list(e: JsonElement?): List<AgentEvent> = e.arr.mapNotNull { decode(it) }
    }
}

data class Snapshot(val events: List<AgentEvent>, val olderBefore: Int?) {
    companion object {
        fun decode(e: JsonElement?): Snapshot? {
            val o = e.obj ?: return null
            return Snapshot(AgentEvent.list(o["events"]), o["olderBefore"].int)
        }
    }
}

/** The answer to `send_msg`: the new index entry only on the send that created it. */
data class SendOutcome(val snapshot: SessionItem?, val queued: Queued?)
