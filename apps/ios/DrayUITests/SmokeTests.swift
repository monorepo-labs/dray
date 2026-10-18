import XCTest

/// Drives the app against a live `dray-serve`: add it, read the list's
/// stages, PR marks and project chips, open a session, answer the permission
/// card a prompt raises, see the reply land.
///
/// Wants a scratch server seeded like `/tmp/dray-541-seed.py` in #541: a
/// `manual` session titled "Phone smoke" to run a real turn in, and sessions
/// in a repo whose remote is the dray GitHub repo, on branches with an open,
/// a draft and a merged PR. `xcodebuild test` passes these through:
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
        // The sheet's own row, not the empty state's button behind the sheet.
        app.cells.buttons["Add server"].tap()
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

        let message = app.textFields["Message"]
        XCTAssertTrue(message.waitForExistence(timeout: 15))
        snap(app, "5-transcript")
        message.tap()
        message.typeText("Run the shell command `touch phone-file.txt`, then reply with the single word PHONE.")
        app.buttons["Send"].tap()

        let allow = app.buttons["Allow once"]
        XCTAssertTrue(allow.waitForExistence(timeout: 90), "no permission card")
        snap(app, "6-card")
        allow.tap()

        let reply = app.staticTexts["PHONE"]
        XCTAssertTrue(reply.waitForExistence(timeout: 90), "reply never landed")
        snap(app, "7-reply")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
