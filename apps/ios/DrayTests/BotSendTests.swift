import XCTest
@testable import Dray

/// #1643: a send is read past its options, wherever clap lets them sit.
final class BotSendTests: XCTestCase {
    private func sends(_ cmd: String) -> [String] {
        sentMessages(cmd, unquoted(cmd)).map { "\($0.target) \($0.bot)" }
    }

    func testReadsASendPastItsOptionsWhereverTheySit() {
        for cmd in [
            #"dray session send --machine vps abc12345 "hi there""#,
            #"dray session send --machine=vps abc12345 "hi there""#,
            #"dray session send abc12345 --machine vps "hi there""#,
            #"dray session send abc12345 "hi there" --machine vps"#,
            #"dray --machine vps session send abc12345 "hi there""#,
            #"dray session --machine=vps send abc12345 "hi there""#,
            #"dray --machine "my vps" send abc12345 "hi there""#,
            #"dray session send --machine="my vps" abc12345 "hi there""#,
            "dray session send --machine vps \\\n  abc12345 \"hi there\"",
            #"dray session send -- abc12345 "hi there""#,
            #"dray session send abc12345 -- --ask"#,
        ] {
            XCTAssertEqual(sends(cmd), ["abc12345 false"], cmd)
        }
    }

    func testReadsABotSendPastAsk() {
        for cmd in [
            #"dray bot send --ask Ops "how goes""#,
            #"dray bot send Ops --ask "how goes""#,
            #"dray bot send --machine vps --ask Ops "how goes""#,
            #"dray --machine vps bot send Ops --ask "how goes""#,
        ] {
            XCTAssertEqual(sends(cmd), ["Ops true"], cmd)
        }
    }

    func testSendsNothingWithoutATargetAndMessage() {
        for cmd in [
            "dray session send --machine vps",
            #"dray session send --machine abc12345 "hi""#,
            #"dray session send --help abc12345 "hi""#,
            "dray session send abc12345\nls",
        ] {
            XCTAssertEqual(sends(cmd), [], cmd)
        }
    }

    func testReadsEverySendInOneCommand() {
        XCTAssertEqual(
            sends("dray session send --machine vps abc12345 hi; dray session send --machine vps bbbb2222 yo"),
            ["abc12345 false", "bbbb2222 false"])
    }

    func testDrawsASendToATaskOnAnotherMachine() throws {
        let id = "01a1d052-e620-74d4-8ef2-aa9965929e13"
        let events = try [
            #"{"type":"tool_call_started","callId":"c","name":"Bash","toolType":"shell","input":{"command":"dray session send --machine vps \#(id) \"ship it\""},"title":null}"#,
            #"{"type":"tool_call_completed","callId":"c","result":{"text":"Delivered.","isError":false}}"#,
        ].enumerated().map { i, payload in
            try JSONDecoder().decode(AgentEvent.self, from: Data(#"{"id":"\#(i)","sessionId":"s","ts":null,"subagent":null,"payload":\#(payload)}"#.utf8))
        }
        let sent = botItems(events).compactMap { item -> String? in
            if case .sent(_, let target, _) = item { return target }
            return nil
        }
        XCTAssertEqual(sent, [id])
    }
}
