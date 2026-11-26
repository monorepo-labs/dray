package com.yogesh.dray

import com.yogesh.dray.model.Entry
import com.yogesh.dray.model.Item
import com.yogesh.dray.model.MdBlock
import com.yogesh.dray.model.Picks
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.Stage
import com.yogesh.dray.model.ToolState
import com.yogesh.dray.model.buildTurns
import com.yogesh.dray.model.groupLabel
import com.yogesh.dray.model.hiding
import com.yogesh.dray.model.imagePaths
import com.yogesh.dray.model.markdownBlocks
import com.yogesh.dray.model.stageRuns
import com.yogesh.dray.model.stripSender
import com.yogesh.dray.model.summaryLabel
import com.yogesh.dray.net.parseConnectLine
import com.yogesh.dray.store.serverId
import com.yogesh.dray.wire.AgentEvent
import com.yogesh.dray.wire.Payload
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.wireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class LogicTest {
    private fun event(id: String, payload: String, subagent: String? = null): AgentEvent =
        AgentEvent.decode(wireJson.parseToJsonElement(
            """{"id":"$id","sessionId":"s","payload":$payload${subagent?.let { ",\"subagent\":$it" } ?: ""}}""",
        ))!!

    private fun tool(id: String, call: String, name: String = "Read", path: String = "/a/b/$call.kt") =
        event(id, """{"type":"tool_call_started","callId":"$call","name":"$name","toolType":"file_read","input":{"file_path":"$path"}}""")

    private fun result(id: String, call: String, error: Boolean = false) =
        event(id, """{"type":"tool_call_completed","callId":"$call","result":{"text":"ok","isError":$error}}""")

    @Test
    fun turnsGroupRunsOfOneToolAndLiftTheAnswer() {
        val events = listOf(
            event("1", """{"type":"user_message","text":"go"}"""),
            tool("2", "c1"), result("3", "c1"),
            tool("4", "c2"), result("5", "c2"),
            event("6", """{"type":"tool_call_started","callId":"c3","name":"Bash","toolType":"shell","input":{"command":"ls"}}"""),
            event("7", """{"type":"assistant_text","text":"Done."}"""),
            event("8", """{"type":"turn_completed","status":"success"}"""),
        )
        val turns = buildTurns(events, busy = false)
        assertEquals(1, turns.size)
        val t = turns[0]
        assertEquals("go", t.prompt?.text)
        assertEquals("Done.", t.finalText)
        assertTrue(t.finalLifted)
        assertEquals(2, t.work.size)
        val group = t.work[0] as Item.Group
        assertEquals(2, group.calls.size)
        assertEquals(2, group.targets)
        // A call with no result in a session not busy is done, not pending forever.
        assertEquals(ToolState.Done, (t.work[1] as Item.Tool).call.state)
        assertEquals("3 tool calls", summaryLabel(t.work))
    }

    @Test
    fun aPromptAbandonsOpenCallsAndSubagentEventsAreSkipped() {
        val events = listOf(
            event("1", """{"type":"user_message","text":"one"}"""),
            tool("2", "c1"),
            event("3", """{"type":"assistant_text","text":"inside"}""", subagent = """{"id":"x"}"""),
            event("4", """{"type":"user_message","text":"two"}"""),
            tool("5", "c2"),
        )
        val turns = buildTurns(events, busy = true)
        assertEquals(2, turns.size)
        assertEquals(ToolState.Done, (turns[0].work.single() as Item.Tool).call.state)
        assertEquals(ToolState.Pending, (turns[1].work.single() as Item.Tool).call.state)
    }

    @Test
    fun aFailedTurnSaysItOnceAndAStopIsNoFailure() {
        val failed = buildTurns(listOf(
            event("1", """{"type":"user_message","text":"go"}"""),
            event("2", """{"type":"assistant_text","text":"Out of credit"}"""),
            event("3", """{"type":"turn_completed","status":"error","finalText":"Out of credit"}"""),
        ), busy = false).single()
        assertEquals("Out of credit", failed.failure)
        assertTrue(failed.work.isEmpty())
        val stopped = buildTurns(listOf(
            event("1", """{"type":"user_message","text":"go"}"""),
            event("2", """{"type":"turn_completed","status":"error","stopReason":"aborted_by_user"}"""),
        ), busy = false).single()
        assertNull(stopped.failure)
    }

    @Test
    fun anUnknownPayloadCostsOnlyItself() {
        val e = event("1", """{"type":"tool_call_started","callId":5}""")
        assertTrue(e.payload is Payload.Other)
    }

    @Test
    fun anAgentSwitchDecodesAndDrawsNothing() {
        val switched = event("3", """{"type":"agent_switched","from":"claude_code","to":"codex","resumed":false}""")
        assertEquals(Payload.AgentSwitched("claude_code", "codex"), switched.payload)
        // Between two calls of one tool, it neither opens a turn nor splits the run.
        val turn = buildTurns(listOf(
            event("1", """{"type":"user_message","text":"go"}"""), tool("2", "c1"), result("2r", "c1"),
            switched, tool("4", "c2"), result("4r", "c2"),
        ), busy = false).single()
        assertEquals(2, (turn.work.single() as Item.Group).calls.size)
    }

    @Test
    fun secretEventsDecodeAndTheirLinesStayOutOfTheFold() {
        val asked = event("2", """{"type":"secret_requested","requestId":"r1","name":"GH_TOKEN","reason":"push","savedNames":["GITHUB_TOKEN"],"closest":"GITHUB_TOKEN"}""")
        val request = (asked.payload as Payload.SecretRequested).request
        assertEquals("r1", asked.payload.askId)
        assertEquals("GITHUB_TOKEN", request.closest)
        assertEquals(false, request.bot)
        val turns = buildTurns(listOf(
            event("1", """{"type":"user_message","text":"go"}"""),
            asked,
            tool("3", "c1"), result("3r", "c1"),
            event("4", """{"type":"assistant_text","text":"Asked for it."}"""),
            event("5", """{"type":"turn_completed","status":"success"}"""),
            event("6", """{"type":"secret_answered","requestId":"r1","name":"GH_TOKEN","outcome":"used","from":"GITHUB_TOKEN"}"""),
            // The answer's own prompt is Dray's: no bubble, and the line's turn carries on.
            event("7", """{"type":"user_message","text":"The secret is at /x","kickoff":true}"""),
            tool("8", "c2"), result("8r", "c2"),
            tool("9", "c3"), result("9r", "c3"),
            event("10", """{"type":"secret_answered","requestId":"r0","name":"OLD","outcome":"replaced"}"""),
            tool("11", "c4"), result("11r", "c4"),
            event("12", """{"type":"assistant_text","text":"Done."}"""),
            event("13", """{"type":"turn_completed","status":"success"}"""),
        ), busy = false)
        assertEquals(2, turns.size)
        val second = turns[1]
        assertNull(second.prompt)
        assertEquals("Done.", second.finalText)
        // A replaced card draws nothing and splits no run.
        assertEquals(3, (second.work.single { it is Item.Group } as Item.Group).calls.size)
        val line = second.segments.single().cards.single()
        assertEquals("used", line.answer?.outcome)
        assertEquals(1, second.rows)
    }

    @Test
    fun aKickoffQueuedIntoARunningTurnDrawsNothing() {
        val turn = buildTurns(listOf(
            event("1", """{"type":"user_message","text":"go"}"""),
            tool("2", "c1"), result("2r", "c1"),
            event("3", """{"type":"user_message","text":"The secret X is at /x","kickoff":true,"queued":true}"""),
            event("4", """{"type":"secret_answered","requestId":"r1","name":"X","outcome":"saved"}"""),
            tool("5", "c2"), result("5r", "c2"),
        ), busy = true).single()
        assertTrue(turn.work.none { it is Item.Prompt })
        assertEquals("saved", turn.segments.single().cards.single().answer?.outcome)
    }

    @Test
    fun aMovedPlanTaskStaysPlanOnPi() {
        assertEquals("plan", Picks.taskStance("pi", "plan"))
        assertEquals("bypassPermissions", Picks.taskStance("pi", "auto"))
        assertEquals("manual", Picks.taskStance("codex", "plan"))
        assertEquals("plan", Picks.taskStance("claude_code", "plan"))
    }

    @Test
    fun relayedPromptsNameTheSenderInsteadOfTheHeader() {
        val text = "[message from the Dray session \"Fix\" (abc) on mac]\n\nhello"
        assertEquals("hello", stripSender(text, "Fix", "abc"))
        assertEquals(text, stripSender(text, "Other", "abc"))
    }

    private fun item(id: String, modified: String, parent: String? = null, status: String = "idle") =
        Entry(SessionKey("srv", id), SessionItem(id, modified = modified, parentSessionId = parent, status = status))

    @Test
    fun runsNestChildrenAndPutTheStrongestStageFirst() {
        val now = Instant.parse("2026-11-21T12:00:00Z").toEpochMilli()
        val list = listOf(
            item("a", "2026-11-21T11:00:00Z"),
            item("b", "2026-11-21T11:30:00Z", parent = "a", status = "completed"),
            item("c", "2026-11-21T11:50:00Z"),
            item("old", "2026-11-10T11:50:00Z"),
        )
        val runs = stageRuns(list, now) { if (it.item.status == "completed") Stage.Completed else Stage.Idle }
        assertEquals(listOf(Stage.Completed, Stage.Idle, Stage.Aside), runs.map { it.stage })
        assertEquals(listOf("a", "b"), runs[0].rows.map { it.key.id })
        assertEquals(1, runs[0].rows[1].depth)
        assertEquals(listOf("old"), runs[2].rows.map { it.key.id })
    }

    @Test
    fun aPinLeadsWithItsNestAndSetAsideBeatsAnInheritedPin() {
        val now = Instant.parse("2026-11-21T12:00:00Z").toEpochMilli()
        fun e(id: String, parent: String? = null, pinned: Boolean? = null, aside: Boolean? = null) =
            Entry(SessionKey("srv", id), SessionItem(id, modified = "2026-11-21T11:00:00Z", parentSessionId = parent, pinned = pinned, aside = aside))
        val list = listOf(
            e("p", pinned = true), e("kid", parent = "p"), e("away", parent = "p", aside = true),
            e("x"), e("y"), e("z"),
            // A stale pinned row still leads: a pin beats the three-day fade.
            Entry(SessionKey("srv", "old"), SessionItem("old", modified = "2026-11-01T11:00:00Z", pinned = true)),
        )
        val runs = stageRuns(list, now) { Stage.Idle }
        assertEquals(listOf(Stage.Pinned, Stage.Idle, Stage.Aside), runs.map { it.stage })
        assertEquals(setOf("p", "kid", "old"), runs[0].rows.map { it.key.id }.toSet())
        assertEquals(1, runs[0].rows.first { it.key.id == "kid" }.depth)
        assertEquals(listOf("away"), runs[2].rows.map { it.key.id })
        // The settled list draws no Pinned run.
        assertTrue(stageRuns(list, now, pins = false) { Stage.Idle }.none { it.stage == Stage.Pinned })
    }

    @Test
    fun aParentCycleStillSplitsPins() {
        val list = listOf(
            Entry(SessionKey("srv", "a"), SessionItem("a", modified = "2026-11-21T11:00:00Z", parentSessionId = "b")),
            Entry(SessionKey("srv", "b"), SessionItem("b", modified = "2026-11-21T11:00:00Z", parentSessionId = "a")),
        )
        val now = Instant.parse("2026-11-21T12:00:00Z").toEpochMilli()
        assertTrue(stageRuns(list, now) { Stage.Idle }.none { it.stage == Stage.Pinned })
    }

    @Test
    fun markdownTablesFencesAndPaths() {
        val blocks = markdownBlocks("# Hi\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode | x\n```\n- one\n- two")
        assertTrue(blocks[0] is MdBlock.Heading)
        assertEquals(listOf(listOf("a", "b"), listOf("1", "2")), (blocks[1] as MdBlock.Table).rows)
        assertEquals("code | x", (blocks[2] as MdBlock.Code).text)
        assertEquals(2, (blocks[3] as MdBlock.Bullets).items.size)
        val text = "Saved it to /tmp/shot.png for you.\n`/tmp/x.png`"
        assertEquals(listOf("/tmp/shot.png", "/tmp/x.png"), imagePaths(text))
        assertEquals("Saved it to for you.", hiding(listOf("/tmp/shot.png", "/tmp/x.png"), text))
        assertEquals(
            "Run `open /tmp/a.png -a Preview` to see.",
            hiding(listOf("/tmp/a.png"), "Run `open /tmp/a.png -a Preview` to see /tmp/a.png."),
        )
    }

    @Test
    fun labelsAndConnectLines() {
        assertEquals("Read 3 files", groupLabel("Read", 3, pending = false))
        assertEquals("Updating 2 todo lists", groupLabel("TodoWrite", 2, pending = true))
        val token = "a".repeat(64)
        assertEquals("wss://x.example" to token, parseConnectLine("wss://x.example $token"))
        assertNull(parseConnectLine("wss://x.example short"))
    }

    /** A relayed welcome's `identity` is matched against this hash of the token the phone holds (#1404). Pinned to serve.rs's value. */
    @Test
    fun serverIdIsTheServersOwnHash() {
        assertEquals("4b3f3d0f73afd9cc", serverId("test-token"))
    }
}
