package com.yogesh.dray

import com.yogesh.dray.model.InboxSection
import com.yogesh.dray.model.Issue
import com.yogesh.dray.model.IssueDetail
import com.yogesh.dray.model.IssuePerson
import com.yogesh.dray.model.MdBlock
import com.yogesh.dray.model.PrDetail
import com.yogesh.dray.model.PullRequest
import com.yogesh.dray.model.PullRow
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.inboxSection
import com.yogesh.dray.model.markdownBlocks
import com.yogesh.dray.model.marksRepo
import com.yogesh.dray.model.matches
import com.yogesh.dray.model.prBodyMarkdown
import com.yogesh.dray.model.prRepoSlug
import com.yogesh.dray.model.sessionsForPr
import com.yogesh.dray.wire.PrListing
import com.yogesh.dray.wire.PrMark
import com.yogesh.dray.wire.SessionItem
import com.yogesh.dray.wire.decodeOrNull
import com.yogesh.dray.wire.wireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PullsTest {
    private fun row(title: String = "Fix the parser", author: String = "yogesharc", branch: String = "worktree-opal", number: Int = 1503) =
        PullRow(
            "srv", "/repo", "github.com/monorepo-labs/dray",
            PrMark(number = number, headRefName = branch, state = "OPEN", url = "https://github.com/monorepo-labs/dray/pull/$number"),
            PrListing(title = title, author = author),
        )

    @Test
    fun repoComesOffTheLink() {
        assertEquals("github.com/monorepo-labs/dray", marksRepo("https://github.com/Monorepo-Labs/dray/pull/7"))
        assertEquals("monorepo-labs/dray", prRepoSlug("https://github.com/monorepo-labs/dray/pull/7"))
        assertEquals("ghe.corp/team/app", prRepoSlug("https://ghe.corp/team/app/pull/7"))
        assertEquals(null, marksRepo("https://github.com/a/b/issues/7"))
    }

    @Test
    fun searchMatchesTitleNumberAuthorAndBranch() {
        val r = row()
        assertTrue(r.matches(""))
        assertTrue(r.matches("parser"))
        assertTrue(r.matches("FIX parser"))
        assertTrue(r.matches("#1503"))
        assertTrue(r.matches("150"))
        assertTrue(r.matches("yogesh"))
        assertTrue(r.matches("opal"))
        assertTrue(r.matches("dray"))
        assertFalse(r.matches("#1504"))
        assertFalse(r.matches("parser lexer"))
    }

    @Test
    fun sectionsFollowTheDesktop() {
        val open = PrMark(number = 1, headRefName = "b", state = "OPEN", mergeable = "MERGEABLE", mergeStateStatus = "CLEAN")
        assertEquals(InboxSection.Ready, inboxSection(open))
        assertEquals(InboxSection.Draft, inboxSection(open.copy(isDraft = true)))
        assertEquals(InboxSection.NeedsYou, inboxSection(open.copy(checksState = "FAILING")))
        assertEquals(InboxSection.Running, inboxSection(open.copy(checksState = "RUNNING")))
        assertEquals(InboxSection.NeedsYou, inboxSection(open.copy(listing = PrListing(reviewRequested = true))))
        assertEquals(InboxSection.Waiting, inboxSection(open.copy(mergeStateStatus = "BLOCKED")))
    }

    @Test
    fun aPrsTasksAreItsBranchNewestFirst() {
        val items = mapOf(
            SessionKey("srv", "a") to SessionItem("a", projectPath = "/repo", branch = "worktree-opal", created = "2026-11-20T00:00:00Z"),
            SessionKey("srv", "b") to SessionItem("b", projectPath = "/repo", branch = "worktree-opal", created = "2026-11-22T00:00:00Z"),
            SessionKey("srv", "c") to SessionItem("c", projectPath = "/repo", branch = "other"),
        )
        assertEquals(listOf("b", "a"), sessionsForPr(row(), items, { _, _ -> null }) { true }.map { it.id })
        val fork = row().copy(listing = PrListing(isCrossRepository = true))
        assertTrue(sessionsForPr(fork, items, { _, _ -> null }) { true }.isEmpty())
    }

    @Test
    fun tagsAndTabledImagesDrawAsPictures() {
        val body = """
            ## Before and after
            <!-- hidden bot state -->
            | Before | After |
            |---|---|
            | ![before](https://img.example/a.png) | ![after](https://img.example/b.png) |

            See <img width="300" alt="shot" src="https://github.com/user-attachments/assets/x" /> here.
            ```
            <img src="kept-in-code">
            ```
        """.trimIndent()
        val out = prBodyMarkdown(body)
        assertFalse(out.contains("hidden bot state"))
        val blocks = markdownBlocks(out)
        val images = blocks.filterIsInstance<MdBlock.Image>().map { it.url }
        assertEquals(listOf("https://img.example/a.png", "https://img.example/b.png", "https://github.com/user-attachments/assets/x"), images)
        val table = blocks.filterIsInstance<MdBlock.Table>().single()
        assertEquals(listOf("before", "after"), table.rows.last())
        assertTrue(blocks.filterIsInstance<MdBlock.Code>().single().text.contains("<img src=\"kept-in-code\">"))
    }

    /** `pr_detail` as #1511's server answers it, and the branch read's fields the page draws beside it. */
    @Test
    fun aDetailAndItsPrDecode() {
        val d = decodeOrNull<PrDetail>(wireJson.parseToJsonElement(
            """{"body":"Hi","createdAt":"2026-11-23T10:00:00Z","authorAvatar":null,"labels":[{"name":"bug","color":"#d73a4a"}],
               "reviewers":[{"name":"r","avatar":null,"state":"changes_requested"}]}""",
        ))
        assertEquals("Hi", d!!.body)
        assertEquals("bug", d.labels.single().name)
        assertEquals("changes_requested", d.reviewers.single().state)
        val pr = decodeOrNull<PullRequest>(wireJson.parseToJsonElement(
            """{"number":7,"title":"T","state":"MERGED","author":"a","baseRefName":"main","headRefName":"feat","headRefExists":true,
               "isCrossRepository":true,"checks":[],"comments":[],"additions":3,"deletions":1,"changedFiles":2,"updatedAt":"2026-11-24T10:00:00Z"}""",
        ))
        assertNotNull(pr)
        assertEquals("feat", pr!!.headRefName)
        assertTrue(pr.isCrossRepository)
        assertEquals("2026-11-24T10:00:00Z", pr.updatedAt)
    }

    @Test
    fun anOpenedIssueKeepsItsRowAndItsTalk() {
        val json = wireJson.parseToJsonElement(
            """{"tracker":"github","id":"I_1","identifier":"a/b#12","title":"Crash","url":"u","state":{"id":"open","name":"Open","kind":"unstarted","color":"#fff"},
               "priority":"none","labels":[],"updatedAt":"2026-11-24T10:00:00Z","pullRequests":[3],
               "description":"Body","comments":[{"author":{"name":"x"},"body":"hey","createdAt":"2026-11-24T10:00:00Z"}],"states":[]}""",
        )
        val d = IssueDetail.decode(json)!!
        assertEquals("#12", d.issue.short)
        assertEquals("Body", d.description)
        assertEquals("hey", d.comments.single().body)
        val issue = Issue(id = "1", identifier = "DRA-53", title = "Parser drops lines", assignee = IssuePerson("Yogesh"))
        assertTrue(issue.matches("dra-53"))
        assertTrue(issue.matches("parser yogesh"))
        assertFalse(issue.matches("lexer"))
    }
}
