import XCTest

/// Drives the app against a live `dray-serve`: add it, open a session,
/// answer the permission card a prompt raises, see the reply land, then run
/// a long turn and watch it fold.
///
/// Wants a scratch server whose newest session runs in `manual` stance, in a
/// directory holding alpha/beta/gamma/delta.txt and notes.md — it runs real
/// turns there, and reruns in the same session pass. `xcodebuild test` passes these through:
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:7399 TEST_RUNNER_DRAY_TOKEN=… xcodebuild test …
final class SmokeTests: XCTestCase {
    func testAddServerAnswerCardAndReply() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launch()
        snap(app, "1-empty")

        // Through the Servers sheet, which offers Add whether or not a server is already saved.
        app.buttons["Servers"].tap()
        // The last match: with no server saved, the empty state's own button sits behind the sheet.
        let adds = app.buttons.matching(identifier: "Add server")
        adds.element(boundBy: adds.count - 1).tap()
        let address = app.textFields["Address"]
        address.tap()
        address.typeText(url)
        let secret = app.textFields["Token"]
        secret.tap()
        secret.typeText(token)
        snap(app, "2-add-server")
        app.buttons["Add"].tap()
        app.buttons["Done"].tap()

        let row = app.collectionViews.cells.firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no session listed")
        snap(app, "3-sessions")
        row.tap()

        // Every word this run waits for carries its own token, so a session
        // holding an earlier run's turns cannot answer for this one.
        let run = String(UUID().uuidString.prefix(6))

        let message = app.textFields["Message"]
        XCTAssertTrue(message.waitForExistence(timeout: 15))
        snap(app, "4-transcript")
        message.tap()
        message.typeText("Run the shell command `touch phone-file.txt`, then reply with the single word PHONE\(run).")
        app.buttons["Send"].tap()

        let allow = app.buttons["Allow once"]
        XCTAssertTrue(allow.waitForExistence(timeout: 90), "no permission card")
        snap(app, "5-card")
        allow.tap()

        // The prompt ends in a full stop, so only the reply ends on the bare word.
        let reply = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "PHONE\(run)")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 90), "reply never landed")
        snap(app, "6-reply")

        // A long turn of read-only calls, which manual stance runs without a card:
        // past five rows it folds as it runs, and lands collapsed.
        message.tap()
        message.typeText("""
            One step at a time, never in parallel, and write one short sentence after each step: \
            glob *.txt, read alpha.txt, grep for needle, read beta.txt, grep for apple, read gamma.txt, \
            glob *.md, read notes.md. Then read delta.txt and alpha.txt back to back with no sentence \
            between them. Then reply with the single word DONE\(run).
            """)
        app.buttons["Send"].tap()

        // This run's rows are the ones below its own prompt.
        let prompt = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "DONE\(run).")).firstMatch
        let summaries = app.buttons.matching(NSPredicate(format: "label CONTAINS 'tool call'"))
        XCTAssertTrue(waitUntil(120) { lowest(summaries, below: prompt) != nil }, "the running turn never folded")
        XCTAssertTrue(app.buttons["Stop"].exists, "the turn finished before it folded")
        snap(app, "7-long-turn-running")

        let done = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "DONE\(run)")).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 180), "long turn never finished")
        snap(app, "8-long-turn-collapsed")
        lowest(summaries, below: prompt)?.tap()
        snap(app, "9-long-turn-open")
        let groups = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Read 2 files'"))
        let group = lowest(groups, below: prompt)
        XCTAssertNotNil(group, "the back-to-back reads did not group")
        group?.tap()
        snap(app, "10-group-open")
    }

    /// The lowest match drawn under `anchor`, or nil.
    private func lowest(_ query: XCUIElementQuery, below anchor: XCUIElement) -> XCUIElement? {
        guard anchor.exists else { return nil }
        let floor = anchor.frame.maxY
        return query.allElementsBoundByIndex.filter { $0.frame.minY > floor }.max { $0.frame.minY < $1.frame.minY }
    }

    private func waitUntil(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(1))
        }
        return condition()
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
