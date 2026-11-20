import XCTest
@testable import Dray

final class ChangesTests: XCTestCase {
    func testUnifiedDiffFoldsUnchangedLines() {
        let old = (1...20).map { "l\($0)" }.joined(separator: "\n") + "\n"
        let new = old.replacingOccurrences(of: "l10\n", with: "ten\n") + "l21\n"
        let rows = unifiedDiff(old: old, new: new, context: 2)
        XCTAssertEqual(rows.first, .gap(7))
        XCTAssertTrue(rows.contains(.line(sign: "-", number: 10, text: "l10")))
        XCTAssertTrue(rows.contains(.line(sign: "+", number: 10, text: "ten")))
        XCTAssertEqual(rows.last, .line(sign: "+", number: 21, text: "l21"))
        XCTAssertEqual(unifiedDiff(old: nil, new: "a\nb"), [.line(sign: "+", number: 1, text: "a"), .line(sign: "+", number: 2, text: "b")])
        XCTAssertEqual(unifiedDiff(old: "same", new: "same"), [])
    }

    /// The desktop's picks for the same paths, each an asset the catalog holds.
    func testFileIconsMatchTheDesktop() {
        let cases = [("src/main.ts", false, "fi-typescript"), ("package.json", false, "fi-nodejs"),
                     ("README.md", false, "fi-readme"), ("a/b.swift", false, "fi-swift"), ("x.unknownext", false, "fi-file"),
                     ("apps/src", true, "fi-folder-src"), ("Dray", true, "fi-folder")]
        for (path, folder, want) in cases {
            XCTAssertEqual(FileIcons.name(path, folder: folder), want, path)
            XCTAssertNotNil(UIImage(named: want), want)
        }
    }

    private func event(_ id: String, _ payload: String) throws -> AgentEvent {
        try JSONDecoder().decode(AgentEvent.self, from: Data(#"{"id":"\#(id)","sessionId":"s","payload":\#(payload)}"#.utf8))
    }

    /// A turn that changed nothing gives way to the one before it, as the desktop's `changeRange` does.
    func testLastTurnSkipsATurnThatWroteNothing() throws {
        let events = try [
            event("1", #"{"type":"user_message","text":"a","baseline":"aaa"}"#),
            event("2", #"{"type":"turn_completed","status":"success","head":"bbb"}"#),
            event("3", #"{"type":"user_message","text":"b","baseline":"bbb"}"#),
            event("4", #"{"type":"turn_completed","status":"success","head":"bbb"}"#),
        ]
        XCTAssertEqual(lastTurnRange(events, running: false)?.base, "aaa")
        XCTAssertEqual(lastTurnRange(events, running: false)?.head, "bbb")
        let running = try events + [event("5", #"{"type":"user_message","text":"c","baseline":"ccc"}"#)]
        XCTAssertEqual(lastTurnRange(running, running: true)?.base, "ccc")
        XCTAssertNil(lastTurnRange(running, running: true)?.head)
        XCTAssertEqual(lastTurnRange(running, running: false)?.base, "aaa")
    }
}
