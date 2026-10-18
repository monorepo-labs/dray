import XCTest
@testable import Dray

/// The readiness order is the logic; each case is one place a reordering would bite.
final class PrTests: XCTestCase {
    private func verdict(state: String = "OPEN", draft: Bool = false, _ mergeable: String, _ status: String) -> MergeVerdict {
        mergeVerdict(state: state, isDraft: draft, mergeable: mergeable, mergeStateStatus: status)
    }

    func testReadinessOrder() {
        // A closed or merged PR's merge state is stale.
        XCTAssertEqual(verdict(state: "MERGED", "CONFLICTING", "DIRTY"), .merged)
        XCTAssertEqual(verdict(state: "CLOSED", "MERGEABLE", "CLEAN"), .closed)
        // A conflict outranks a draft and an unknown.
        XCTAssertEqual(verdict(draft: true, "CONFLICTING", "UNKNOWN"), .conflict)
        XCTAssertEqual(verdict("UNKNOWN", "DIRTY"), .conflict)
        // A draft is stored, so an UNKNOWN window cannot hide it.
        XCTAssertEqual(verdict(draft: true, "UNKNOWN", "UNKNOWN"), .draft)
        // A leftover status is not trusted while GitHub recomputes.
        XCTAssertEqual(verdict("UNKNOWN", "BLOCKED"), .unknown)
        XCTAssertEqual(verdict("MERGEABLE", "UNKNOWN"), .unknown)
        XCTAssertEqual(verdict("MERGEABLE", "BEHIND"), .behind)
        XCTAssertEqual(verdict("MERGEABLE", "BLOCKED"), .blocked)
        XCTAssertEqual(verdict("MERGEABLE", "UNSTABLE"), .unstable)
        XCTAssertEqual(verdict("MERGEABLE", "CLEAN"), .ready)
        XCTAssertEqual(verdict("MERGEABLE", "HAS_HOOKS"), .ready)
    }

    func testSessionBranch() {
        XCTAssertEqual(sessionBranch(branch: "main", worktreeName: "a", worktreeRemoved: false, observed: "fix"), "fix")
        XCTAssertEqual(sessionBranch(branch: "main", worktreeName: "a", worktreeRemoved: false, observed: nil), "worktree-a")
        XCTAssertEqual(sessionBranch(branch: "main", worktreeName: nil, worktreeRemoved: false, observed: nil), "main")
        // A relocated session's shared checkout never answers.
        XCTAssertEqual(sessionBranch(branch: "worktree-a", worktreeName: nil, worktreeRemoved: true, observed: "main"), "worktree-a")
    }

    func testCommentTextKeepsCode() {
        XCTAssertEqual(commentText("<!-- x --><b>Use</b> `Array<T>` &amp;\n```\n<div>&amp;</div>\n```"),
                       "Use `Array<T>` &\n```\n<div>&amp;</div>\n```")
        XCTAssertEqual(commentText("[vc]: #abc `foo`\n<h2>Title</h2>"), "Title")
        XCTAssertEqual(commentText("<!-- hidden `state` -->Shown"), "Shown")
        // Markers inside code are examples, and stay.
        XCTAssertEqual(commentText("Use `<!-- keep -->`\n```\n[vc]: #abc\n```"), "Use `<!-- keep -->`\n```\n[vc]: #abc\n```")
    }

    func testUnavailableReadsTheServersObject() {
        let u = PrUnavailable.from(DrayError(#"{"kind":"not_authenticated"}"#))
        XCTAssertEqual(u.kind, "not_authenticated")
        XCTAssertTrue(u.keepsButton)
        XCTAssertEqual(PrUnavailable.from(DrayError("Not connected")).sentence, "Not connected")
    }
}
