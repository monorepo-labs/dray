import XCTest
@testable import Dray

/// When a server is offered an update, mirroring `servers.rs`'s `behind`.
final class ReleaseTests: XCTestCase {
    func testBehind() {
        XCTAssertTrue(Releases.behind("0.13.10", "0.13.12"), "numeric, not lexical")
        XCTAssertFalse(Releases.behind("0.13.12", "0.13.12"))
        XCTAssertFalse(Releases.behind("0.14.0", "0.13.12"), "ahead is not behind")
        XCTAssertTrue(Releases.behind("0.12.0-beta.10", "0.12.0"), "a beta sorts below its own release")
        XCTAssertFalse(Releases.behind("0.13.0-beta.1", "0.12.0"))
    }
}
