package com.yogesh.dray

import com.yogesh.dray.model.InboxSection
import com.yogesh.dray.model.Issue
import com.yogesh.dray.model.IssueDetail
import com.yogesh.dray.model.IssuePerson
import com.yogesh.dray.model.MdBlock
import com.yogesh.dray.model.PrCheckout
import com.yogesh.dray.model.PrComment
import com.yogesh.dray.model.PrDetail
import com.yogesh.dray.model.PullRequest
import com.yogesh.dray.model.PullRow
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.model.inboxSection
import com.yogesh.dray.model.markdownBlocks
import com.yogesh.dray.model.marksRepo
import com.yogesh.dray.model.matches
import com.yogesh.dray.model.prBodyMarkdown
import com.yogesh.dray.model.prInitial
import com.yogesh.dray.model.prMachines
import com.yogesh.dray.model.prPrompt
import com.yogesh.dray.model.commentMarkdown
import com.yogesh.dray.model.issueInitial
import com.yogesh.dray.model.issueMachines
import com.yogesh.dray.model.issuePrompt
import com.yogesh.dray.model.issueRepo
import com.yogesh.dray.model.prRepoSlug
import com.yogesh.dray.model.sessionsForPr
import com.yogesh.dray.wire.PrListing
import com.yogesh.dray.wire.PrMark
import com.yogesh.dray.wire.Project
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

    private val review = PrComment(
        author = "greptile", body = "Two nits", url = "u/r1", kind = "changes_requested", createdAt = "1", nodeId = "R1",
        replies = listOf(
            PrComment(author = "greptile", body = "Rename `x`<!-- bot -->", url = "u/t1", path = "a.kt:3", createdAt = "2", nodeId = "T1"),
            PrComment(author = "greptile", body = "Done", url = "u/t2", path = "b.kt:9", resolved = true, createdAt = "3", nodeId = "T2"),
        ),
    )

    @Test
    fun thePromptNamesThePrThenTheReadersWords() {
        val pr = PullRequest(number = 9, title = "Fix it", url = "https://github.com/a/b/pull/9", baseRefName = "main", headRefName = "feat", comments = listOf(review))
        val prompt = prPrompt(pr, "  go  ")
        assertTrue(prompt.startsWith("Pull request #9 \"Fix it\" — https://github.com/a/b/pull/9\nBranch feat into main."))
        assertFalse(prompt.contains("Rename"))
        assertTrue(prompt.endsWith("\n\ngo"))
        assertFalse(prPrompt(pr, "").endsWith("\n\n"))
    }

    @Test
    fun anOpenedCommentDropsBotMarkersAndKeepsPictures() {
        val md = commentMarkdown("[vc]: #abc\n<!-- state -->Looks good\n<img src=\"https://x/y.png\" alt=\"shot\">")
        assertEquals("Looks good\n![shot](https://x/y.png)", md)
        assertEquals("```\n[vc]: #keep\n```", commentMarkdown("```\n[vc]: #keep\n```"))
        // Greptile's severity badges, as captured on #888: SVGs, so their words stand in.
        val badge = """<a href="#"><img alt="P1" src="https://g.s3.amazonaws.com/badges/p1.svg?v=9" align="top"></a> **Bad** ![x](https://a/b.SVG)"""
        assertEquals("P1 **Bad** x", commentMarkdown(badge))
        // Vercel's project logo at 16px; a real screenshot keeps its picture.
        assertEquals("| dray |", commentMarkdown("""| <a href="https://vercel.com/a/dray"><sup><img src="https://vercel.com/api/www/avatar?s=32" width="16" height="16" alt="" /></sup></a> [dray](https://vercel.com/a/dray) |""")
            .replace(Regex("\\[(dray)]\\([^)]*\\)"), "$1"))
        assertEquals("![](https://x/shot.png)", commentMarkdown("""<img src="https://x/shot.png" width="800">"""))
    }

    @Test
    fun anIssueStartsInItsRepoElseAClone() {
        val gh = Issue(tracker = "github", id = "I_1", identifier = "Monorepo-Labs/dray#12", title = "Crash", url = "https://github.com/monorepo-labs/dray/issues/12")
        val projects = mapOf(
            "srv" to listOf(Project("/other", "other", remote = "github.com/a/b"), Project("/repo", "dray", remote = "github.com/monorepo-labs/dray")),
            "two" to listOf(Project("/x", "x")),
        )
        val all = issueMachines(gh, listOf("srv", "two")) { projects[it].orEmpty() }
        assertEquals(listOf(PrCheckout(PrCheckout.Kind.Here, "srv", "/repo"), PrCheckout(PrCheckout.Kind.Clone, "two", "~/dray/dray")), all)
        assertEquals(PrCheckout(PrCheckout.Kind.Here, "srv", "/repo"), issueInitial("two", all))
        assertEquals("Monorepo-Labs/dray", issueRepo(gh))
        // Linear names no repository: every project is a place, the one picked last first.
        val linear = Issue(id = "L1", identifier = "DRA-53", title = "Parser")
        assertEquals(null, issueRepo(linear))
        assertEquals(listOf("/other", "/repo", "/x"), issueMachines(linear, listOf("srv", "two")) { projects[it].orEmpty() }.map { it.path })
        assertEquals(null, issueInitial("srv", emptyList()))
    }

    @Test
    fun anIssuesPromptIsItsTagLinkBodyThenNote() {
        val gh = Issue(tracker = "github", id = "I_1", identifier = "a/b#12", title = "Crash", url = "u")
        assertEquals("#a/b#12 Crash\nu\n\nBody\n\ngo", issuePrompt(gh, " Body ", " go "))
        assertEquals("#a/b#12 Crash\nu", issuePrompt(gh, null, ""))
    }

    @Test
    fun aPrStartsOnItsCheckoutElseAttachesElseClones() {
        val r = row().copy(repo = "github.com/monorepo-labs/dray", key = "/elsewhere")
        val projects = mapOf("srv" to listOf(Project("/repo", "dray", remote = "github.com/monorepo-labs/dray")), "two" to emptyList())
        val all = prMachines(r, listOf("srv", "two")) { projects[it].orEmpty() }
        assertEquals(
            listOf(
                PrCheckout(PrCheckout.Kind.Attach, "srv", "/elsewhere"), PrCheckout(PrCheckout.Kind.Here, "srv", "/repo"),
                PrCheckout(PrCheckout.Kind.Clone, "two", "~/dray/dray"),
            ),
            all,
        )
        assertEquals(PrCheckout(PrCheckout.Kind.Attach, "srv", "/elsewhere"), prInitial(r, all))
        val slug = r.copy(key = "github:monorepo-labs/dray")
        assertEquals(PrCheckout(PrCheckout.Kind.Here, "srv", "/repo"), prInitial(slug, prMachines(slug, listOf("srv")) { projects[it].orEmpty() }))
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
