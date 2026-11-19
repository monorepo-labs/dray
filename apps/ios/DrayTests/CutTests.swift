import XCTest
@testable import Dray

/// A `lite` read cuts tool bodies and marks them `_cut`: a row must read the mark,
/// show no figure counted off a fragment, and know to ask for its call.
final class CutTests: XCTestCase {
    private func events(_ lines: [String]) throws -> [AgentEvent] {
        try lines.map { try JSONDecoder().decode(AgentEvent.self, from: Data($0.utf8)) }
    }

    private func line(_ id: String, _ payload: String) -> String {
        #"{"id":"\#(id)","sessionId":"s","ts":null,"subagent":null,"payload":\#(payload)}"#
    }

    func testCutMarkReachesTheRow() throws {
        let turns = buildTurns(try events([
            line("p", #"{"type":"user_message","text":"go"}"#),
            line("a", #"{"type":"tool_call_started","callId":"c1","name":"Edit","toolType":"file_edit","input":{"file_path":"/x","old_string":"a","new_string":"b\nc","_cut":true},"title":null}"#),
            line("b", #"{"type":"tool_call_completed","callId":"c1","result":{"text":"ok","isError":false}}"#),
            line("c", #"{"type":"tool_call_started","callId":"c2","name":"Bash","toolType":"shell","input":{"command":"ls"},"title":null}"#),
            line("d", #"{"type":"tool_call_completed","callId":"c2","result":{"text":"0123","isError":false,"structured":{"_cut":true}}}"#),
            line("e", #"{"type":"tool_call_started","callId":"c3","name":"Bash","toolType":"shell","input":{"command":"pwd"},"title":null}"#),
            line("f", #"{"type":"tool_call_completed","callId":"c3","result":{"text":"/","isError":false,"structured":{"_cut":"true"}}}"#),
        ]), busy: false)
        let calls = turns[0].work.compactMap { item -> ToolCall? in if case .tool(let c) = item { c } else { nil } }
            + turns[0].work.flatMap { item -> [ToolCall] in if case .group(_, _, let c, _, _) = item { c } else { [] } }
        let byId = Dictionary(uniqueKeysWithValues: calls.map { ($0.callId ?? "", $0) })
        XCTAssertEqual(byId["c1"]?.cut, true)
        XCTAssertNil(byId["c1"].flatMap(editCounts))
        XCTAssertEqual(byId["c2"]?.cut, true)
        XCTAssertEqual(byId["c3"]?.cut, false)
    }

    func testRunAsksForItsCutTextCalls() throws {
        let sub = #"{"id":"spawn","label":"Explore"}"#
        let events = try events([
            line("a", #"{"type":"tool_call_started","callId":"spawn","name":"Agent","toolType":"subagent_spawn","input":{"prompt":"look","_cut":true},"title":null}"#),
            #"{"id":"b","sessionId":"s","ts":null,"subagent":\#(sub),"payload":{"type":"tool_call_started","callId":"hb","name":"SubagentHandback","toolType":"other","input":{"message":"found it","_cut":true},"title":null}}"#,
            #"{"id":"c","sessionId":"s","ts":null,"subagent":\#(sub),"payload":{"type":"tool_call_started","callId":"ls","name":"Bash","toolType":"shell","input":{"command":"ls","_cut":true},"title":null}}"#,
        ])
        let run = buildRuns(events, session: SessionKey(server: UUID(), id: "s"), live: [], busy: false).first
        // The Bash row asks for itself when opened; the brief and the answer have no row to.
        XCTAssertEqual(run?.cutCalls, ["spawn", "hb"])
    }

    func testWholeEditStillCounts() throws {
        let call = ToolCall(id: "a", name: "Edit", toolType: "file_edit",
                            input: .object(["old_string": .string("a"), "new_string": .string("b\nc")]),
                            title: nil, output: nil, state: .done)
        XCTAssertEqual(editCounts(call).map { [$0.added, $0.removed] }, [2, 1])
    }
}
