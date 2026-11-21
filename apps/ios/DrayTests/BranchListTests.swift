import XCTest
@testable import Dray

/// `worktreeOptions`, the twin of the desktop's `worktreeBranchOptions`.
final class BranchListTests: XCTestCase {
    private let list = BranchList(current: "main", branches: ["main", "fix", "release/2", "prefix-match"],
                                  remoteBranches: ["feature/x", "main-old"], defaultBase: "origin/main", dirty: 0)

    func testDefaultPulledOutAndPlacesKept() {
        XCTAssertEqual(list.defaultBranch, "main")
        let o = list.worktreeOptions("")
        XCTAssertEqual(o.local, ["fix", "release/2", "prefix-match"])
        XCTAssertEqual(o.remote, ["feature/x", "main-old"])
    }

    func testQueryKeepsMatchesPrefixFirst() {
        let o = list.worktreeOptions(" FI ")
        XCTAssertEqual(o.local, ["fix", "prefix-match"])
        XCTAssertEqual(o.remote, [])
    }

    func testOlderServerAndLoneBranch() {
        let lone = BranchList(current: "main", branches: ["main"], defaultBase: nil, dirty: 0)
        XCTAssertNil(lone.defaultBranch)
        XCTAssertFalse(lone.offersWorktreeBase)
        XCTAssertEqual(lone.worktreeOptions("").remote, [])
        XCTAssertEqual(BranchList(current: nil, branches: [], defaultBase: "upstream/feature/y", dirty: 0).defaultBranch, "feature/y")
    }
}
