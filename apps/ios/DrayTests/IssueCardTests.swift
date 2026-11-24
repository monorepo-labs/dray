import XCTest
@testable import Dray

/// #1506: an issue card decodes off the wire, and a hand-off marks its own card's row alone.
final class IssueCardTests: XCTestCase {
    private func events(_ lines: [(String, String)]) throws -> [AgentEvent] {
        try lines.map { id, payload in
            try JSONDecoder().decode(AgentEvent.self, from: Data(#"{"id":"\#(id)","sessionId":"s","ts":null,"subagent":null,"payload":\#(payload)}"#.utf8))
        }
    }

    func testHandOffMarksItsOwnCard() throws {
        let card = ##"{"type":"issue_card","repo":"o/r","issues":[{"number":1,"title":"One","url":"u","closed":false,"labels":[{"name":"bug","color":"#d73a4a"}]},{"number":6,"title":"Six","url":"u","closed":true,"labels":[]}]}"##
        let items = botItems(try events([
            ("c1", card),
            ("c2", card),
            ("a", #"{"type":"issue_approved","cardId":"c2","number":1}"#),
        ]))
        XCTAssertEqual(items.count, 2)
        guard case .issues(_, let first, let session, let firstStarted, _) = items[0],
              case .issues(_, _, _, let secondStarted, _) = items[1] else { return XCTFail("not two issue cards") }
        XCTAssertEqual(first.repo, "o/r")
        XCTAssertEqual(first.issues.map(\.number), [1, 6])
        XCTAssertEqual(first.issues[1].closed, true)
        XCTAssertEqual(first.issues[0].labels.first?.name, "bug")
        XCTAssertEqual(session, "s")
        XCTAssertEqual(firstStarted, [])
        XCTAssertEqual(secondStarted, [1])
    }
}
