import XCTest

/// Drives the app against a live `dray-serve`: add it, read the list's
/// stages, PR marks and project chips, open a session, answer the permission
/// card a prompt raises, see the reply land, then run a long turn and watch
/// it fold.
///
/// Wants a scratch server seeded like `/tmp/dray-541-seed.py` in #541: a
/// `manual` session titled "Phone smoke" to run real turns in, in a directory
/// holding alpha/beta/gamma/delta.txt and notes.md, and sessions in a repo
/// whose remote is the dray GitHub repo, on branches with an open, a draft and
/// a merged PR. Reruns in the same session pass. `xcodebuild test` passes these through:
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

        let row = app.staticTexts["Phone smoke"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no session listed")
        // Marks need `gh` on the server's side, about a second per repo.
        let glyph = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Pull request #'")).firstMatch
        XCTAssertTrue(glyph.waitForExistence(timeout: 30), "no PR marks")
        snap(app, "3-sessions")

        // The desktop's stages: unread (a nest rides its child's), idle, open PR, merged, set aside.
        let order = ["Unread done", "Plain idle", "Spawned child", "Phone smoke", "Open PR work", "Merged PR work", "Old aside"]
        let ys = order.map { app.staticTexts[$0].frame.minY }
        XCTAssertEqual(ys, ys.sorted(), "rows out of stage order: \(zip(order, ys).map { "\($0) \($1)" })")

        app.buttons["dray-541-gh"].tap()
        XCTAssertFalse(row.waitForExistence(timeout: 2), "project chip did not filter")
        XCTAssertTrue(app.staticTexts["Open PR work"].exists)
        snap(app, "4-filtered")
        app.buttons["All"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()

        // Every word this run waits for carries its own token, so a session
        // holding an earlier run's turns cannot answer for this one.
        let run = String(UUID().uuidString.prefix(6))

        let message = app.textFields["Message"]
        XCTAssertTrue(message.waitForExistence(timeout: 15))
        snap(app, "5-transcript")
        message.tap()
        message.typeText("Run the shell command `touch phone-file.txt`, then reply with the single word PHONE\(run).")
        app.buttons["Send"].tap()

        let allow = app.buttons["Allow once"]
        XCTAssertTrue(allow.waitForExistence(timeout: 90), "no permission card")
        snap(app, "6-card")
        allow.tap()

        // The prompt ends in a full stop, so only the reply ends on the bare word.
        let reply = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "PHONE\(run)")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 90), "reply never landed")
        snap(app, "7-reply")

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
        snap(app, "8-long-turn-running")

        let done = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "DONE\(run)")).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 180), "long turn never finished")
        snap(app, "9-long-turn-collapsed")
        lowest(summaries, below: prompt)?.tap()
        snap(app, "10-long-turn-open")
        let groups = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Read 2 files'"))
        let group = lowest(groups, below: prompt)
        XCTAssertNotNil(group, "the back-to-back reads did not group")
        // delta.txt is read only inside the group, so its row shows once the group opens.
        let delta = app.buttons.matching(NSPredicate(format: "label CONTAINS 'delta.txt'"))
        XCTAssertNil(lowest(delta, below: prompt), "the group's calls showed before it opened")
        group?.tap()
        XCTAssertTrue(waitUntil(5) { lowest(delta, below: prompt) != nil }, "the group did not open to its calls")
        snap(app, "11-group-open")
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
