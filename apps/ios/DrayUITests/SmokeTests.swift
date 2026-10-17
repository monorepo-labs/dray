import XCTest

/// Drives the app against a live `dray-serve`: add it, open a session,
/// answer the permission card a prompt raises, see the reply land.
///
/// Wants a scratch server whose newest session runs in `manual` stance —
/// it runs a real turn there. `xcodebuild test` passes these through:
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
        app.buttons["Add server"].firstMatch.tap()
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

        let message = app.textFields["Message"]
        XCTAssertTrue(message.waitForExistence(timeout: 15))
        snap(app, "4-transcript")
        message.tap()
        message.typeText("Run the shell command `touch phone-file.txt`, then reply with the single word PHONE.")
        app.buttons["Send"].tap()

        let allow = app.buttons["Allow once"]
        XCTAssertTrue(allow.waitForExistence(timeout: 90), "no permission card")
        snap(app, "5-card")
        allow.tap()

        let reply = app.staticTexts["PHONE"]
        XCTAssertTrue(reply.waitForExistence(timeout: 90), "reply never landed")
        snap(app, "6-reply")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
