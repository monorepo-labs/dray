package com.yogesh.dray

import com.yogesh.dray.model.Item
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.ToolState
import com.yogesh.dray.model.buildRuns
import com.yogesh.dray.model.outputPath
import com.yogesh.dray.model.runItems
import com.yogesh.dray.ui.Releases
import com.yogesh.dray.wire.AgentEvent
import com.yogesh.dray.wire.wireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RunsTest {
    private val key = SessionKey("srv", "s")

    private fun event(id: String, payload: String, subagent: String? = null): AgentEvent =
        AgentEvent.decode(wireJson.parseToJsonElement(
            """{"id":"$id","sessionId":"s","ts":"2026-11-21T06:00:0${id.last()}Z","payload":$payload${subagent?.let { ",\"subagent\":$it" } ?: ""}}""",
        ))!!

    private val agent = """{"id":"t1","label":"local_agent"}"""
    private val shell = """{"id":"b1","label":"local_bash"}"""

    private val events = listOf(
        event("1", """{"type":"user_message","text":"go"}"""),
        event("2", """{"type":"tool_call_started","callId":"t1","name":"Task","toolType":"subagent_spawn","input":{"prompt":"Look around"}}"""),
        event("3", """{"type":"subagent_started","agentId":"a1","description":"Explore the repo"}""", agent),
        event("4", """{"type":"tool_call_started","callId":"r1","name":"Read","toolType":"file_read","input":{"file_path":"/x"}}""", agent),
        event("5", """{"type":"subagent_progress","agentId":"a1","description":"Reading /x"}""", agent),
        event("6", """{"type":"tool_call_started","callId":"b1","name":"Bash","toolType":"shell","input":{"command":"npm run dev","run_in_background":true}}"""),
        event("7", """{"type":"tool_call_completed","callId":"b1","result":{"text":"Output is being written to: /tmp/tasks/b1.output","isError":false}}"""),
        event("8", """{"type":"subagent_started","agentId":"bash_1","label":"local_bash"}""", shell),
    )

    @Test
    fun runsReadNewestFirstWithTheirLifecycle() {
        val runs = buildRuns(events, key, live = setOf("a1", "bash_1"), busy = true)
        assertEquals(listOf("b1", "t1"), runs.map { it.id })
        val sub = runs[1]
        assertEquals("a1", sub.taskId)
        assertEquals("Explore the repo", sub.title)
        assertEquals("Reading /x", sub.status)
        assertEquals("Look around", sub.brief)
        assertFalse(sub.done)
        assertFalse(sub.shell)
        assertTrue(sub.chat)
        // The run's own work, its lifecycle events left out.
        assertEquals(1, sub.events.size)
        val bash = runs[0]
        assertTrue(bash.shell)
        assertEquals("npm run dev", bash.command)
        assertEquals("/tmp/tasks/b1.output", outputPath(bash.answer))
        assertFalse(bash.done)
    }

    @Test
    fun aRunOutsideTheLiveSetIsOverOnceNothingCouldAnswer() {
        // The child no longer holds the subagent, and the session is idle: no completion is coming.
        val idle = buildRuns(events, key, live = setOf("bash_1"), busy = false)
        assertTrue(idle.first { it.id == "t1" }.done)
        // Busy, and its spawning call unanswered: it may still report.
        val busy = buildRuns(events, key, live = setOf("bash_1"), busy = true)
        assertFalse(busy.first { it.id == "t1" }.done)
        // A shell whose call answered is done once its task is gone.
        assertTrue(buildRuns(events, key, live = emptySet(), busy = true).first { it.id == "b1" }.done)
    }

    @Test
    fun aCompletionClosesTheRun() {
        val done = events + event("9", """{"type":"subagent_completed","agentId":"a1"}""", """{"id":"t1"}""")
        val run = buildRuns(done, key, live = setOf("a1"), busy = true).first { it.id == "t1" }
        assertTrue(run.done)
        // The completion's envelope carries no label, so the first one sticks.
        assertEquals("local_agent", run.label)
    }

    @Test
    fun runItemsDrawTheHandbackAsText() {
        val items = runItems(listOf(
            event("1", """{"type":"user_message","text":"brief"}"""),
            event("2", """{"type":"tool_call_started","callId":"r1","name":"Read","toolType":"file_read","input":{"file_path":"/x"}}"""),
            event("3", """{"type":"tool_call_started","callId":"h1","name":"SubagentHandback","toolType":"other","input":{"message":"All done"}}"""),
            event("4", """{"type":"assistant_text","text":"  "}"""),
        ), done = false)
        assertEquals(3, items.size)
        assertTrue(items[0] is Item.Prompt)
        assertEquals(ToolState.Pending, (items[1] as Item.Tool).call.state)
        assertEquals("All done", (items[2] as Item.Text).text)
        // A finished run's unanswered call is done, not pending forever.
        val read = event("2", """{"type":"tool_call_started","callId":"r1","name":"Read","toolType":"file_read","input":{}}""")
        assertEquals(ToolState.Done, (runItems(listOf(read), done = true)[0] as Item.Tool).call.state)
    }

    @Test
    fun releasesCompareNumericallyAndBetasSortBelow() {
        assertTrue(Releases.behind("0.9.3", "0.10.0"))
        assertFalse(Releases.behind("0.10.0", "0.10.0"))
        assertTrue(Releases.behind("0.10.0-beta.2", "0.10.0"))
        assertFalse(Releases.behind("0.11.0-beta.1", "0.10.0"))
        assertEquals("0.10.0", Releases.newest(listOf("cli-v0.9.3", "cli-v0.10.0", "cli-v0.11.0-beta.1", "v0.32.1"), "cli-v"))
        assertEquals("0.32.1", Releases.newest(listOf("cli-v0.9.3", "v0.32.1", "v0.33.0-beta.1"), "v"))
        assertNull(outputPath("no path here"))
    }
}
