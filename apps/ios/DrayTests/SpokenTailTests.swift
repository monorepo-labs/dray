import XCTest
@testable import Dray

/// A voice reply's bubble shows its end, so a second recording shows what it added.
final class SpokenTailTests: XCTestCase {
    func testShortTextShowsWhole() {
        XCTAssertEqual(spokenTail("Fix the header."), "Fix the header.")
    }

    func testLongTextKeepsTheEndCutAtAWord() {
        let text = String(repeating: "older words here ", count: 10) + "and the newest thing said"
        let tail = spokenTail(text, limit: 40)
        XCTAssertTrue(tail.hasPrefix("…"))
        XCTAssertTrue(tail.hasSuffix("and the newest thing said"))
        XCTAssertFalse(tail.dropFirst().hasPrefix(" "), "cut inside a word or before a space")
        XCTAssertTrue(text.hasSuffix(tail.dropFirst()), "not a tail of the text")
    }
}
