import XCTest
@testable import Dray

/// A relayed prompt's `from` holds Bools and numbers beside its strings, and must still name its sender.
final class SenderTests: XCTestCase {
    private func event(_ id: String, _ payload: String) throws -> AgentEvent {
        try JSONDecoder().decode(AgentEvent.self, from: Data(#"{"id":"\#(id)","sessionId":"s","ts":null,"subagent":null,"payload":\#(payload)}"#.utf8))
    }

    func testRoutineReportIsHiddenFromTheBotChat() throws {
        let items = botItems([
            // As the server logged it mid-turn on 2026-11-28.
            try event("r", #"{"type":"user_message","text":"[message from the Dray routine \"Morning scan\" (01a2)]\n\nNo issues.","queued":true,"from":{"sessionId":"01a2","title":"Morning scan","machine":null,"routine":true}}"#),
            try event("a", #"{"type":"assistant_text","text":"Nothing to do this morning."}"#),
        ])
        XCTAssertEqual(items.count, 1)
        guard case .assistant = items[0] else { return XCTFail("the report drew a row") }
    }

    func testBotAskStillDrawsAsTheBot() throws {
        let items = botItems([
            try event("b", #"{"type":"user_message","text":"hi","from":{"sessionId":"x","title":"Ops","machine":null,"botId":"ops","chain":"c","hop":2,"ask":true}}"#),
        ])
        guard case .botMessage(_, let botId, let title, _, _) = items.first else { return XCTFail("not a bot message") }
        XCTAssertEqual(botId, "ops")
        XCTAssertEqual(title, "Ops")
    }
}
