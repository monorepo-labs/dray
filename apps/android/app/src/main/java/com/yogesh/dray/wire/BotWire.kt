package com.yogesh.dray.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** A Blobatar face: a shape name and hue degrees. iOS's `BotAvatar`. */
@Serializable
data class BotAvatar(val shape: String, val hue: Double)

/** The bot's own face pick; absent for a bot made before there was one, which draws the face its id seeds. */
val Bot.face: BotAvatar? get() = decodeOrNull<BotAvatar>(avatar)

/** `bot_previews`' answer per chat: its row's line, worded by the server ("You: …", "Reacted 👍 to …", or the newest reply), and how many replies came since the reader last wrote. */
@Serializable
data class BotPreview(
    val text: String? = null,
    val replies: Int = 0,
    /** `text` is one plain line already, drawn as it is; false from a server that sends the raw reply. */
    val plain: Boolean = false,
)

/** `dray session merge-card`'s card: the task, its repo and the PR to land. */
@Serializable
data class MergeCard(
    val taskId: String,
    val title: String = "",
    /** The repo root, where `pr_marks` and `merge_pr` run. */
    val projectPath: String = "",
    val branch: String = "",
    val number: Int,
    val url: String = "",
    /** The machine holding the task, where it is not the chat's; `repo` comes with it. */
    val machine: String? = null,
    val repo: String? = null,
) {
    /** Where `pr_marks` and `merge_pr` run on the chat's server: the checkout, or for a task on another machine its GitHub slug. */
    val prPath: String get() = repo?.let { "github:$it" } ?: projectPath
}

/** `dray session issue-card`'s card: GitHub issues the bot showed the reader, as GitHub had them when posted. */
@Serializable
data class IssueCard(
    /** `owner/name`. */
    val repo: String,
    val issues: List<IssueCardRow> = emptyList(),
)

/** One issue on an [IssueCard]. `closed` is a bool, never a state enum, so a state an older build cannot spell fails nothing. */
@Serializable
data class IssueCardRow(
    val number: Int,
    val title: String = "",
    val url: String = "",
    val closed: Boolean = false,
    val labels: List<IssueLabel> = emptyList(),
)

/** A label in the colour GitHub gave it: six hex digits, no `#`. */
@Serializable
data class IssueLabel(val name: String, val color: String = "")

/** One file a bot's turn changed under its instructions, skills or memory. */
@Serializable
data class Lesson(
    val path: String,
    /** `instructions`, `skill` or `memory`. */
    val kind: String = "",
    /** `added`, `changed` or `removed`. */
    val change: String = "",
    val summary: String = "",
)

/**
 * One bot's "Waiting on you" card as its server judged it (#1259): `bot_stalls` answers every
 * bot's, `bot_stalls_changed` carries one, `live_state` all of them.
 */
data class BotStalls(val botId: String, val chatId: String, val rows: List<StallRow>, val tasks: Int, val judged: List<String>) {
    companion object {
        fun decode(e: JsonElement?): BotStalls? {
            val botId = e["botId"].str ?: return null
            return BotStalls(botId, e["chatId"].str ?: "", decodeList(e["rows"]), e["tasks"].int ?: 0, decodeList(e["judged"]))
        }
    }
}

/** A card row, oldest stall first. `key` is what a dismissal stores. */
@Serializable
data class StallRow(
    val key: String,
    /** `waiting` or `ready`. */
    val kind: String,
    /** A ready PR GitHub is working out again after a merge: drawn, not mergeable. */
    val checking: Boolean = false,
    val since: Double = 0.0,
    /** The bot's line for the reader, written since the task last moved. */
    val need: String? = null,
    val pr: PrMark? = null,
    /** The task as its own server indexes it. */
    val item: SessionItem,
    /** The machine a task started with `--machine` runs on; none for the bot's own server. */
    val machine: String? = null,
    /** Its machine did not answer: nothing to open, merged through GitHub by `repo`. */
    val offline: Boolean = false,
    /** `owner/name`, for merging through the bot's server a task the phone cannot reach. */
    val repo: String? = null,
)
