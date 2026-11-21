package com.yogesh.dray.store

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.yogesh.dray.model.AgentAvailability
import com.yogesh.dray.model.Model
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.wire.Bot
import com.yogesh.dray.wire.Project
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.wireJson
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import java.io.File
import java.time.Instant
import java.util.UUID

/** The new task's draft: one for the app, so a closed sheet keeps what was written. */
val NEW_SESSION = SessionKey("", "new")

/** One entry in the project menu; [path] is set only where the server holds two projects of this name. */
data class ProjectChoice(val name: String, val path: String?) {
    val label: String get() = path?.let { "$name — ${File(it).parentFile?.name.orEmpty()}" } ?: name
}

/**
 * The new task's picks and the send that starts a task on them: the desktop composer's rules
 * (`Picks`), cut to what the phone offers — machine, project, worktree, agent, model, effort,
 * fast mode and stance. The last picks are the defaults next time. iOS's NewTask.swift.
 */
class NewTask(private val store: Store, context: Context) {
    private val prefs = context.getSharedPreferences("new", Context.MODE_PRIVATE)

    /** A project by name, so one repo checked out on two machines is one pick. */
    var projectName by mutableStateOf(prefs.getString("project", null))
        private set
    /** One of two same-named projects on a machine, by path; null where the name is enough. */
    var projectPath by mutableStateOf<String?>(null)
        private set
    /** The machine picked; null or one not connected takes the first holding the last project. */
    var pickedServer by mutableStateOf(prefs.getString("server", null))
        private set
    var harness by mutableStateOf(prefs.getString("harness", null) ?: "claude_code")
        private set
    var stance by mutableStateOf(prefs.getString("stance", null) ?: "auto")
        private set
    var fast by mutableStateOf(prefs.getBoolean("fast", false))
        private set
    var worktree by mutableStateOf(prefs.getBoolean("worktree", false))
        private set
    private var modelPicks by mutableStateOf(readMap("models"))
    private var effortPicks by mutableStateOf(readMap("efforts"))
    var modelId by mutableStateOf("")
        private set
    private val agents = mutableStateMapOf<String, List<AgentAvailability>>()
    private val models = mutableStateMapOf<String, List<Model>>()
    /** Lists that failed to read: not cached, so asking again retries, and no longer holding Start. */
    private val modelsFailed = mutableStateMapOf<String, Boolean>()
    /** Machines whose agents could not be read; the next load asks again. */
    private val agentsFailed = mutableStateMapOf<String, Boolean>()
    var sending by mutableStateOf(false)
        private set
    /** Why the last start or save failed, said over the field. */
    var failure by mutableStateOf<String?>(null)
    /**
     * A bot with no chat yet: the send goes to its folder, which is what starts the chat.
     * Any other machine or project pick leaves it.
     */
    var bot by mutableStateOf<Pair<String, Bot>?>(null)
        private set

    var text: String
        get() = store.drafts[NEW_SESSION].orEmpty()
        set(v) { if (v.isEmpty()) store.drafts.remove(NEW_SESSION) else store.drafts[NEW_SESSION] = v }
    val hasText: Boolean get() = text.isNotBlank()

    val connected get() = store.live.filter { store.serverState[it.id] == ConnState.Connected }

    /** The server comes first and the project is picked from what it holds, so a machine with nothing attached is still a place to start. */
    val server: String?
        get() {
            val c = connected
            // A bot's folder is on its own machine: down, there is nowhere to send, never another machine.
            bot?.let { (s, _) -> return s.takeIf { id -> c.any { it.id == id } } }
            return c.firstOrNull { it.id == pickedServer }?.id
                ?: c.firstOrNull { s -> store.projects[s.id].orEmpty().any { it.name == projectName } }?.id
                ?: c.firstOrNull()?.id
        }

    private val held: List<Project> get() = server?.let { store.projects[it] }.orEmpty()

    /** The picked server's projects by name, newest pick first. */
    val projectNames: List<String> get() = held.sortedByDescending { it.lastSelected }.map { it.name }.distinct()

    /** The picked project where this server has it, else the one picked last here. */
    val project: String? get() = bot?.second?.name ?: projectName?.takeIf { it in projectNames } ?: projectNames.firstOrNull()

    val cwd: String?
        get() {
            bot?.let { return it.second.path }
            val named = held.filter { it.name == project }
            return named.firstOrNull { it.path == projectPath }?.path ?: named.firstOrNull()?.path
        }

    /** The project menu: a name per repo, split by folder where the server holds two of that name. */
    val projectChoices: List<ProjectChoice>
        get() = projectNames.flatMap { name ->
            val paths = held.filter { it.name == name }.map { it.path }
            if (paths.size > 1) paths.map { ProjectChoice(name, it) } else listOf(ProjectChoice(name, null))
        }

    val projectChoice: ProjectChoice?
        get() = projectChoices.firstOrNull { it.name == project && it.path == cwd } ?: projectChoices.firstOrNull { it.name == project && it.path == null }

    private val modelsKey get() = "${server.orEmpty()}|$harness"
    val list: List<Model> get() = models[modelsKey].orEmpty()
    val model: Model? get() = list.firstOrNull { it.id == modelId }
    val effort: String? get() = model?.let { Picks.usableEffort(it, effortPicks[modelId]) } ?: effortPicks[modelId]
    val available: List<AgentAvailability> get() = server?.let { agents[it] }.orEmpty()
    private val agent get() = available.firstOrNull { it.harness == harness }
    val stanceLabel: String get() = Picks.stances.firstOrNull { it.first == Picks.stanceFor(harness, stance) }?.second ?: "Auto"

    val ready: Boolean
        get() {
            // An unread availability lets Start stand: `send_msg` refuses a missing agent itself, in words.
            val agentOk = agent?.available == true || server?.let { agentsFailed[it] } == true
            val modelsOk = models[modelsKey] != null || modelsFailed[modelsKey] == true
            return !sending && hasText && cwd != null && agentOk && modelsOk
        }

    fun aim(at: Bot, on: String) { bot = on to at }

    fun pickServer(id: String?) {
        bot = null
        pickedServer = id
        projectPath = null
        prefs.edit().putString("server", id).apply()
    }

    fun pick(choice: ProjectChoice) {
        // The menu lists the bot's machine's projects, so leaving the bot stays on that machine.
        bot?.let { pickServer(it.first) }
        bot = null
        projectName = choice.name
        projectPath = choice.path
        prefs.edit().putString("project", choice.name).apply()
    }

    /** After an attach, the project just added is the pick. */
    fun pickProject(name: String?) {
        projectName = name
        projectPath = null
        prefs.edit().putString("project", name).apply()
    }

    fun pickHarness(h: String) { harness = h; prefs.edit().putString("harness", h).apply() }
    fun pickStance(s: String) { stance = s; prefs.edit().putString("stance", s).apply() }
    fun pickFast(on: Boolean) { fast = on; prefs.edit().putBoolean("fast", on).apply() }
    fun pickWorktree(on: Boolean) { worktree = on; prefs.edit().putBoolean("worktree", on).apply() }

    fun pickModel(id: String) {
        modelId = id
        modelPicks = modelPicks + (harness to id)
        writeMap("models", modelPicks)
    }

    fun pickEffort(level: String) {
        effortPicks = effortPicks + (modelId to level)
        writeMap("efforts", effortPicks)
    }

    /** What the picks need from the machine they point at: its agents and this agent's models, read once per machine and agent. */
    suspend fun load() {
        val server = server ?: return
        if (agents[server] == null) {
            val read = runCatching { decodeList<AgentAvailability>(store.call(server, "agent_availability")) }.getOrNull()
            if (read != null) { agents[server] = read; agentsFailed.remove(server) } else agentsFailed[server] = true
        }
        // A machine without the remembered agent starts on one it has; with only one, no picker shows to fix it.
        // Only while that machine is still the pick: a late answer for another must not move this one's agent.
        val known = agents[server]
        if (server == this.server && known != null && known.none { it.harness == harness && it.available }) {
            known.firstOrNull { it.available }?.let { pickHarness(it.harness) }
        }
        // Taken before the read: the picks can move to another machine while it is out.
        val harness = harness
        val key = "$server|$harness"
        if (models[key] == null) {
            runCatching { decodeList<Model>(store.call(server, "list_models", jsonOf("harness" to harness))) }
                .onSuccess { models[key] = it; modelsFailed.remove(key) }
                .onFailure { modelsFailed[key] = true }
        }
        // At once on the list landing: the old agent's model must never go out under the new agent's name.
        if (key == modelsKey) modelId = Picks.usableModel(list, modelPicks[harness] ?: Picks.defaultModel[harness].orEmpty(), harness)
    }

    /** The argument set `useSessions.ts` sends for a new session, stance and fast narrowed to what this agent and model honour. */
    suspend fun start(): SessionKey? {
        val server = server ?: return null
        val cwd = cwd ?: return null
        if (!ready) return null
        sending = true
        failure = null
        val id = UUID.randomUUID().toString().lowercase()
        val sent = text
        return try {
            val reply = store.call(server, "send_msg", jsonOf(
                "sessionId" to id,
                "prompt" to sent,
                "attachmentPaths" to emptyList<String>(),
                "harness" to harness,
                "model" to modelId,
                "effort" to effort,
                "permissionMode" to Picks.stanceFor(harness, stance),
                "fast" to (fast && Picks.offersFast(harness, model)),
                "cwd" to cwd,
                "branch" to null,
                "useWorktree" to (worktree && bot == null),
                "worktreeName" to null,
                "baseRef" to null,
                "isNewSession" to true,
            ))
            decodeOrNull<SessionItem>(reply["snapshot"])?.let { store.created(server, it) }
            bot = null
            // Words added while the start was out were never sent, so they stay.
            if (text == sent) text = ""
            SessionKey(server, id)
        } catch (e: Exception) {
            failure = e.message ?: "The server didn't answer."
            null
        } finally {
            sending = false
        }
    }

    /** Saves the text as a draft in Dray's sidebar, on these picks, and clears it. */
    suspend fun saveDraft(): Boolean {
        if (sending) return false
        val server = server
        val cwd = cwd
        if (server == null || cwd == null || !hasText) {
            failure = "Pick a project first."
            return false
        }
        sending = true
        val saved = text
        return try {
            store.call(server, "create_draft", jsonOf("draft" to jsonOf(
                "id" to UUID.randomUUID().toString().lowercase(),
                "prompt" to saved,
                "created" to Instant.now().toString(),
                "projectPath" to cwd,
                "harness" to harness,
                "model" to modelId,
                "effort" to effort,
                "permissionMode" to Picks.stanceFor(harness, stance),
                "fast" to (fast && Picks.offersFast(harness, model)),
                "useWorktree" to worktree,
            )))
            if (text == saved) text = ""
            true
        } catch (e: Exception) {
            failure = e.message ?: "The server didn't answer."
            false
        } finally {
            sending = false
        }
    }

    private val mapSerializer = MapSerializer(String.serializer(), String.serializer())

    private fun readMap(key: String): Map<String, String> =
        prefs.getString(key, null)?.let { runCatching { wireJson.decodeFromString(mapSerializer, it) }.getOrNull() }.orEmpty()

    private fun writeMap(key: String, value: Map<String, String>) =
        prefs.edit().putString(key, wireJson.encodeToString(mapSerializer, value)).apply()
}
