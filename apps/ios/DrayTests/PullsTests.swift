import XCTest
@testable import Dray

/// The pull requests page's rules, restated from `prInbox.ts`: each case is one its tests pin.
final class PullsTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) -> T {
        try! JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func mark(draft: Bool = false, checks: String = "CLEAR", mergeable: String = "MERGEABLE", status: String = "CLEAN",
                      review: String? = nil, requested: Bool = false, mine: Bool = false) -> PrMark {
        decode("""
        {"number":7,"headRefName":"feature","isDraft":\(draft),"state":"OPEN","checksState":"\(checks)",
         "url":"https://github.com/O/R/pull/7","mergeable":"\(mergeable)","mergeStateStatus":"\(status)",
         "reviewDecision":\(review.map { "\"\($0)\"" } ?? "null"),
         "listing":{"title":"Fix it","author":"a","authorAvatar":null,"updatedAt":"2026-11-20T00:00:00Z","additions":1,
                    "deletions":0,"commentCount":0,"isCrossRepository":false,"viewerDidAuthor":\(mine),"reviewRequested":\(requested)}}
        """)
    }

    func testSections() {
        XCTAssertEqual(inboxSection(mark(draft: true, checks: "FAILING")), .draft)
        XCTAssertEqual(inboxSection(mark(checks: "FAILING")), .needsYou)
        XCTAssertEqual(inboxSection(mark(mergeable: "CONFLICTING")), .needsYou)
        XCTAssertEqual(inboxSection(mark(requested: true)), .needsYou)
        XCTAssertEqual(inboxSection(mark(review: "CHANGES_REQUESTED", mine: true)), .needsYou)
        XCTAssertEqual(inboxSection(mark(review: "CHANGES_REQUESTED")), .ready, "only changes asked of the reader's own PR need them")
        // Running outranks a green verdict beside it.
        XCTAssertEqual(inboxSection(mark(checks: "RUNNING")), .running)
        XCTAssertEqual(inboxSection(mark()), .ready)
        XCTAssertEqual(inboxSection(mark(status: "BLOCKED")), .waiting)
    }

    /// Every word must land in the title, number, author, head branch or repository.
    func testSearch() {
        let m = mark()
        let row = PullRow(server: UUID(), key: "/p", repo: "github.com/o/r", mark: m, listing: m.listing!)
        XCTAssertTrue(pullMatches(row, ""))
        XCTAssertTrue(pullMatches(row, "fix #7"))
        XCTAssertTrue(pullMatches(row, "FEATURE"))
        XCTAssertTrue(pullMatches(row, "o/r"))
        XCTAssertFalse(pullMatches(row, "fix other"))
    }

    /// A dragged-in screenshot's tag becomes an image line; other HTML and markers go.
    func testPrBody() {
        let body = "Before<img width=\"300\" alt=\"x\" src=\"https://u.example/a.png\" />after\n<!-- bot -->\n<details><summary>More</summary>text</details>"
        XCTAssertEqual(prBody(body), "Before\n![](https://u.example/a.png)\nafter\n\nMoretext")
    }

    func testTaskCopyOnConnectedServer() {
        let item: SessionItem = decode("""
        {"sessionId":"s1","harness":"claude_code","cwd":"/p/.claude/worktrees/w","projectPath":"/p","title":"t","model":"opus",
         "permissionMode":"auto","status":"idle","modified":"2026-11-20T00:00:00Z","branch":"feature"}
        """)
        let (down, up) = (UUID(), UUID())
        let row = PullRow(server: up, key: "/p", repo: "github.com/o/r", mark: mark(), listing: mark().listing!)
        let items = [(key: SessionKey(server: down, id: "s1"), item: item), (key: SessionKey(server: up, id: "s1"), item: item)]
        let found = sessionsForPr(row, items, repoOf: { _, _ in "github.com/o/r" }, connected: { $0 == up })
        XCTAssertEqual(found, [SessionKey(server: up, id: "s1")])
    }

    func testRepoSpellings() {
        XCTAssertEqual(marksRepo("https://github.com/Monorepo-Labs/Dray/pull/12"), "github.com/monorepo-labs/dray")
        XCTAssertEqual(prRepoSlug("https://github.com/Monorepo-Labs/Dray/pull/12"), "Monorepo-Labs/Dray")
        XCTAssertEqual(prRepoSlug("https://ghe.example.com/o/r/pull/1"), "ghe.example.com/o/r")
        XCTAssertNil(marksRepo("https://github.com/o/r/issues/1"))
    }

    private let pr: PullRequest = {
        try! JSONDecoder().decode(PullRequest.self, from: Data("""
        {"number":7,"title":"Fix it","url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":false,"author":"a",
         "baseRefName":"main","headRefName":"feature","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,
         "checks":[],"comments":[],"additions":1,"deletions":0,"changedFiles":1}
        """.utf8))
    }()

    func testPrompt() {
        XCTAssertEqual(prPrompt(pr, text: "  Please look again.  "),
                       "Pull request #7 \"Fix it\" — https://github.com/o/r/pull/7\nBranch feature into main.\n\n`gh pr view 7 --comments` has its conversation.\n\nPlease look again.")
        XCTAssertTrue(prPrompt(pr, text: " ").hasSuffix("has its conversation."))
    }

    func testIssuePrompt() {
        let issue = Issue(tracker: "github", id: "I_1", identifier: "o/r#12", title: "Login fails", url: "https://github.com/o/r/issues/12",
                          state: IssueState(id: "", name: "Open", kind: "unstarted", color: ""), priority: "none", assignee: nil, author: nil,
                          labels: [], team: nil, project: nil, updatedAt: "", pullRequests: [], issueType: nil)
        XCTAssertEqual(issueRepo(issue), "o/r")
        XCTAssertEqual(issuePrompt(issue, body: " Steps to reproduce. ", note: " Start with the form. "),
                       "#o/r#12 Login fails\nhttps://github.com/o/r/issues/12\n\nSteps to reproduce.\n\nStart with the form.")
        XCTAssertEqual(issuePrompt(issue, body: nil, note: ""), "#o/r#12 Login fails\nhttps://github.com/o/r/issues/12")
        let linear = Issue(tracker: "linear", id: "x", identifier: "DRA-5", title: "T", url: "", state: issue.state, priority: "none",
                           assignee: nil, author: nil, labels: [], team: nil, project: nil, updatedAt: "", pullRequests: [], issueType: nil)
        XCTAssertNil(issueRepo(linear))
        XCTAssertEqual(issuePrompt(linear, body: "", note: "go"), "#DRA-5 T\n\ngo")
    }
}
