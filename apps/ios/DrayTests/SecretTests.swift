import XCTest
@testable import Dray

/// #1605: where a secret card's line lands in a task's turns, and that the
/// prompt carrying the secret's path draws no bubble.
final class SecretTests: XCTestCase {
    private func events(_ lines: [(String, String)]) throws -> [AgentEvent] {
        try lines.map { id, payload in
            try JSONDecoder().decode(AgentEvent.self, from: Data(#"{"id":"\#(id)","sessionId":"s","ts":null,"subagent":null,"payload":\#(payload)}"#.utf8))
        }
    }

    private let asked = #"{"type":"secret_requested","requestId":"r","name":"GH_TOKEN","reason":"gh login"}"#
    private func answered(_ outcome: String) -> String {
        #"{"type":"secret_answered","requestId":"r","name":"GH_TOKEN","outcome":"\#(outcome)"}"#
    }

    /// The server logs the path's prompt, then the answer; either order leads the new turn.
    func testAnswerLeadsTheTurnItsPathOpens() throws {
        let path = #"{"type":"user_message","text":"GH_TOKEN is at /x","kickoff":true}"#
        for (first, second) in [(("k", path), ("a", answered("saved"))), (("a", answered("saved")), ("k", path))] {
            let turns = buildTurns(try events([
                ("p", #"{"type":"user_message","text":"log in"}"#),
                ("q", asked),
                ("t", #"{"type":"assistant_text","text":"Asked for it."}"#),
                ("c", #"{"type":"turn_completed","status":"completed"}"#),
                first, second,
                ("d", #"{"type":"assistant_text","text":"Done."}"#),
            ]), busy: false)
            XCTAssertEqual(turns.count, 2)
            XCTAssertNil(turns[1].prompt, "the path's prompt drew a bubble")
            XCTAssertEqual(turns[1].lead.map(\.id), ["a"])
            XCTAssertTrue(turns[1].secrets.isEmpty)
            XCTAssertTrue(turns[0].secrets.isEmpty && turns[0].lead.isEmpty, "the ask itself drew a line")
        }
    }

    /// Answered while the agent still works: the path's prompt is queued into that turn, and still no bubble.
    func testQueuedPathDrawsNoBubble() throws {
        let turns = buildTurns(try events([
            ("p", #"{"type":"user_message","text":"log in"}"#),
            ("q", asked),
            ("t", #"{"type":"assistant_text","text":"Asked; carrying on."}"#),
            ("k", #"{"type":"user_message","text":"GH_TOKEN is at /x","queued":true,"kickoff":true}"#),
            ("a", answered("saved")),
        ]), busy: true)
        XCTAssertEqual(turns.count, 1)
        XCTAssertFalse(turns[0].work.contains { $0.isPrompt }, "the queued path drew a bubble")
        XCTAssertEqual(turns[0].secrets.map(\.id), ["a"])
    }

    func testReplacedCardDrawsNothing() throws {
        let turns = buildTurns(try events([("p", #"{"type":"user_message","text":"x"}"#), ("a", answered("replaced"))]), busy: false)
        XCTAssertTrue(turns.allSatisfy { $0.secrets.isEmpty && $0.lead.isEmpty })
        XCTAssertTrue(botItems(try events([("a", answered("replaced"))])).isEmpty)
        XCTAssertEqual(botItems(try events([("a", answered("declined"))])).count, 1)
    }
}
