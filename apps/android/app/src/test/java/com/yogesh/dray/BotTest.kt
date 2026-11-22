package com.yogesh.dray

import com.yogesh.dray.model.Blobatar
import com.yogesh.dray.model.BotItem
import com.yogesh.dray.model.BotRow
import com.yogesh.dray.model.SentTo
import com.yogesh.dray.model.Unread
import com.yogesh.dray.model.botItems
import com.yogesh.dray.model.botRows
import com.yogesh.dray.model.chatTime
import com.yogesh.dray.model.currentTool
import com.yogesh.dray.model.inReviewTurn
import com.yogesh.dray.model.lessonKind
import com.yogesh.dray.model.previewLine
import com.yogesh.dray.model.prStatus
import com.yogesh.dray.model.sentMessages
import com.yogesh.dray.model.unquoted
import com.yogesh.dray.model.unreadStart
import com.yogesh.dray.wire.AgentEvent
import com.yogesh.dray.wire.BotAvatar
import com.yogesh.dray.wire.Lesson
import com.yogesh.dray.wire.PrMark
import com.yogesh.dray.wire.arr
import com.yogesh.dray.wire.double
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.str
import com.yogesh.dray.wire.wireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneOffset

class BotTest {
    private fun ev(id: String, payload: String) =
        AgentEvent.decode(wireJson.parseToJsonElement("""{"id":"$id","sessionId":"s","ts":"2026-11-21T10:00:00Z","subagent":null,"payload":$payload}"""))!!

    private fun q(s: String) = kotlinx.serialization.json.JsonPrimitive(s).toString()

    private fun user(id: String, text: String, kickoff: Boolean = false) =
        ev(id, """{"type":"user_message","text":${q(text)},"kickoff":$kickoff}""")

    private fun said(id: String, text: String) = ev(id, """{"type":"assistant_text","text":"$text"}""")

    private fun bash(id: String, call: String, cmd: String) =
        ev(id, """{"type":"tool_call_started","callId":"$call","name":"Bash","toolType":"command","input":{"command":${q(cmd)}}}""")

    private fun done(id: String, call: String, text: String) =
        ev(id, """{"type":"tool_call_completed","callId":"$call","result":{"text":${q(text)},"isError":false}}""")

    @Test
    fun drawsTheConversationAndNotTheWork() {
        val items = botItems(listOf(
            user("u1", "Kick off", kickoff = true),
            user("u2", "Fix the login"),
            said("a1", "On it."),
            bash("t1", "c1", "ls -la"),
            done("t2", "c1", "file"),
            ev("r1", """{"type":"reaction","messageId":"u2","emoji":"👀"}"""),
            ev("r2", """{"type":"reaction","messageId":"u2","emoji":"✅"}"""),
        ))
        assertEquals(listOf("u2", "a1"), items.map { it.id })
        assertEquals("✅", (items[0] as BotItem.User).reaction)
    }

    @Test
    fun theReadersReactionSitsOnTheReplyAndItsNoteDrawsNothing() {
        val items = botItems(listOf(
            user("u1", "Fix the login"),
            said("a1", "Fixed."),
            ev("r1", """{"type":"reaction","messageId":"a1","emoji":"👍","byUser":true}"""),
            ev("r2", """{"type":"reaction","messageId":"a1","emoji":"❤️","byUser":true}"""),
            user("u2", "The user reacted ❤️ (love) to your message", kickoff = true),
            said("a2", "Glad it works!"),
        ))
        assertEquals(listOf("u1", "a1", "a2"), items.map { it.id })
        assertNull((items[0] as BotItem.User).reaction)
        assertEquals("❤️", (items[1] as BotItem.Assistant).reaction)
        assertEquals("s", (items[1] as BotItem.Assistant).sessionId)
    }

    @Test
    fun aFailedTurnDrawsItsSentenceOnce() {
        val items = botItems(listOf(
            user("u1", "Go"),
            said("a1", "Usage limit reached"),
            ev("t", """{"type":"turn_completed","status":"error","stopReason":"stop_sequence","finalText":"Usage limit reached"}"""),
        ))
        assertEquals(listOf("u1", "t"), items.map { it.id })
        assertEquals("Usage limit reached", (items[1] as BotItem.Notice).text)
    }

    @Test
    fun readsStartsAndSendsFromTheBotsCommands() {
        val id = "3f0c2a9e-1b2c-4d5e-8f90-123456789abc"
        val items = botItems(listOf(
            bash("t1", "c1", "dray session new --title x 'do it'"),
            done("t2", "c1", "$id\n"),
            bash("t3", "c2", "dray session send aaaa1111 'hi' && dray session send bbbb2222 \"yo\""),
            done("t4", "c2", "sent"),
            bash("t5", "c3", "dray bot send Ops 'ship it'"),
            done("t6", "c3", "Sent to bot \"Ops\" (9d3e5a1c-0000-4000-8000-000000000001)."),
        ))
        assertEquals(BotItem.Task("c1", id, null, "2026-11-21T10:00:00Z"), items[0])
        val rows = botRows(items)
        assertEquals(listOf("aaaa1111", "bbbb2222"), (rows[1] as BotRow.Talk).targets)
        val sent = (rows[2] as BotRow.One).item as BotItem.BotSent
        assertEquals("Ops", sent.name)
        assertEquals("9d3e5a1c-0000-4000-8000-000000000001", sent.botId)
    }

    @Test
    fun aServerLoggedTaskWinsOverTheShellCall() {
        val id = "3f0c2a9e-1b2c-4d5e-8f90-123456789abc"
        val items = botItems(listOf(
            bash("t1", "c1", "dray session new 'do it'"),
            ev("ts", """{"type":"task_started","taskId":"$id","title":"Do it"}"""),
            done("t2", "c1", "$id\n"),
        ))
        assertEquals(listOf("ts"), items.map { it.id })
    }

    @Test
    fun aHiddenReviewDrawsNothingAndLessonsDrawEach() {
        val items = botItems(listOf(
            user("u1", "Review: The user just corrected you.", kickoff = true),
            said("a1", "Nothing to keep."),
            ev("l", """{"type":"learned","commit":"abc","files":[{"path":"AGENTS.md","kind":"instructions","change":"changed","summary":"Check"},{"path":"s.md","kind":"skill","change":"added","summary":"Fork"}]}"""),
            ev("x", """{"type":"learned_undone","commit":"abc","path":"s.md"}"""),
        ))
        assertEquals(listOf("l:AGENTS.md", "l:s.md"), items.map { it.id })
        assertFalse((items[0] as BotItem.Learned).undone)
        assertTrue((items[1] as BotItem.Learned).undone)
        assertEquals("New skill", lessonKind(Lesson("p", "skill", "added", "")))
        assertEquals("Rule", lessonKind(Lesson("p", "instructions", "changed", "")))
        assertTrue(inReviewTurn(listOf(user("u1", "Review: x", kickoff = true))))
    }

    @Test
    fun readsSendsOutOfEachShellQuoting() {
        assertEquals(listOf(SentTo("abc12345", false)), sentMessages("dray send abc12345 'it'\\''s done'", unquoted("dray send abc12345 'it'\\''s done'")))
        fun sends(cmd: String) = sentMessages(cmd, unquoted(cmd)).map { it.target }
        assertEquals(listOf("abc12345"), sends("dray session send abc12345 \"$(cat <<'EOF'\nline one\nEOF\n)\""))
        assertEquals(emptyList<String>(), sends("dray session ls"))
        assertEquals(listOf("Release Ops", "Research"), sends("dray bot send \"Release Ops\" \"ship it\" && dray bot send Research 'look'"))
        assertEquals(emptyList<String>(), sends("dray bot send Ops"))
        assertEquals(listOf("Ops", "Keeper"), sends("dray bot send Ops 'Reply with dray bot send Research \"done\"' && dray bot send Keeper hi"))
        assertEquals(emptyList<String>(), sends("for id in aaa bbb; do dray session send \"\$id\" \"hello\"; done"))
        assertEquals(listOf("aaaa1111", "cccc3333"), sends("dray session send aaaa1111 \"$(cat <<'EOF'\nthen run dray session send bbbb2222 \"x\"\nEOF\n)\" && dray session send cccc3333 ok"))
        assertEquals(listOf("aaaa1111", "cccc3333"), sends("cat <<'EOF' >/tmp/brief; dray session send aaaa1111 hi\nsay dray session send bbbb2222 no\nEOF\ndray session send cccc3333 ok"))
        assertEquals(listOf("aaaa1111"), sends("cat <<< \"hello\"\ndray session send aaaa1111 hi"))
        assertEquals(listOf("cccc3333"), sends("cat <<END-TEXT\ndray session send bbbb2222 no\nEND-TEXT\ndray session send cccc3333 ok"))
        assertEquals(emptyList<String>(), sends("printf '' <<EOF\ndray session send aaaa1111 \"example only\""))
        assertEquals(listOf("aaaa1111", "bbbb2222"), sends("dray send aaaa1111 \"Explain <<EOF\nsyntax\"; dray send bbbb2222 hi\ncat <<EOF\nbody\nEOF"))
    }

    @Test
    fun theNewDividerWaitsForTheReadersLastMessage() {
        val items = listOf(
            BotItem.User("u", "hi", emptyList(), null, null),
            BotItem.Assistant("a1", "one", null),
            BotItem.Assistant("a2", "two", null),
        )
        assertEquals(Unread("a1"), unreadStart(items, "a2", complete = false))
        assertNull(unreadStart(items.drop(1), "a2", complete = false))
        assertEquals(Unread("a1"), unreadStart(items.drop(1), "a2", complete = true))
        assertEquals(Unread(null), unreadStart(items.take(1), "u", complete = false))
    }

    @Test
    fun theOrbLineNamesTheOpenCall() {
        val events = listOf(user("u", "go"), bash("t1", "c1", "dray session new 'x'"))
        assertTrue(currentTool(events)!!.contains("dray session new"))
        assertNull(currentTool(events + done("t2", "c1", "ok") + ev("e", """{"type":"turn_completed","status":"success"}""")))
    }

    @Test
    fun previewIsOnePlainLine() {
        assertEquals("Done. See the PR and ship.", previewLine("## Done.\n\nSee **the** [PR](http://x)\n```\ncode\n```\nand `ship`."))
    }

    @Test
    fun statusReadsChecksBeforeTheMergeState() {
        val pr = PrMark(1, "b", state = "OPEN", mergeable = "MERGEABLE", mergeStateStatus = "BLOCKED")
        assertEquals("blocked", prStatus(pr))
        assertEquals("checksFailing", prStatus(pr.copy(checksState = "FAILING")))
        assertEquals("ready", prStatus(pr.copy(mergeStateStatus = "CLEAN")))
        assertEquals("conflict", prStatus(pr.copy(mergeable = "CONFLICTING", checksState = "FAILING")))
        assertEquals("merged", prStatus(pr.copy(state = "MERGED")))
    }

    @Test
    fun chatTimeSaysTodayYesterdayAndTheDay() {
        val zone = ZoneOffset.UTC
        val now = LocalDateTime.of(2026, 11, 21, 12, 0).toInstant(zone).toEpochMilli()
        fun at(d: Int, h: Int) = LocalDateTime.of(2026, 11, d, h, 5).toInstant(zone).toEpochMilli()
        assertEquals("Today 09:05", chatTime(at(21, 9), now, zone))
        assertEquals("Yesterday 18:05", chatTime(at(20, 18), now, zone))
        assertTrue(chatTime(at(10, 18), now, zone).endsWith("18:05"))
    }

    /** Held to Blobatar's own output: `blobatar_faces.gen.js` wrote the file from the island's `botface.js`. */
    @Test
    fun facesMatchTheJavaScript() {
        val text = javaClass.classLoader!!.getResource("blobatar_faces.json")!!.readText()
        val cases = wireJson.parseToJsonElement(text).arr
        assertTrue(cases.size > 30)
        for (c in cases) {
            val (seed, pick, svg) = c.arr
            val avatar = pick["shape"].str?.let { BotAvatar(it, pick["hue"].double!!) }
            val body = svg.str!!.substringAfter("height=\"64\">").removeSuffix("</svg>")
            assertEquals("${seed.str} $avatar", body, Blobatar.svg(Blobatar.face(seed.str!!, avatar)))
        }
    }

    @Test
    fun seededFacesAreStable() {
        assertEquals(Blobatar.seededAvatar("abc"), Blobatar.seededAvatar("abc"))
        assertTrue(Blobatar.shapes.any { it.first == Blobatar.seededAvatar("3f0c2a9e").shape })
    }
}
