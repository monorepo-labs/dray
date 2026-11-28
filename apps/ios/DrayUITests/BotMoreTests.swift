import XCTest

/// A bot's attachments and routines under its tasks, against a real server
/// holding a bot whose chat has a picture you sent, one it read, a recording and
/// two routines: the list, a picture in the viewer, the recording in AVKit, a
/// routine turned off and on, and one deleted from its long-press menu.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=Snapper xcodebuild test …
final class BotMoreTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testAttachmentsAndRoutines() throws {
        guard let name = env["DRAY_BOT"] else { throw XCTSkip("set TEST_RUNNER_DRAY_BOT") }
        let app = try connected()
        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 20), "no bot row")
        bot.tap()
        XCTAssertTrue(app.buttons["Tasks"].waitForExistence(timeout: 10))
        app.buttons["Tasks"].tap()

        let rows = app.buttons.matching(identifier: "attachmentRow")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "no attachments listed")
        XCTAssertEqual(rows.count, 3, "a picture sent, a picture read and a recording")
        XCTAssertTrue(app.buttons["Open island-panel.png"].exists, "the read picture is named by the file it was read from")
        XCTAssertTrue(app.buttons["Play Recording"].exists || app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Play '")).count == 1)
        // Both sides present, so the filters show.
        XCTAssertTrue(app.buttons["You"].exists && app.buttons["AI"].exists, "no filters over a mixed list")
        app.swipeUp()
        let routines = app.otherElements.matching(identifier: "routineRow")
        XCTAssertTrue(routines.firstMatch.waitForExistence(timeout: 10), "no routines listed")
        XCTAssertEqual(routines.count, 2)
        sleep(1)
        snap(app, "sheet-large")

        app.buttons["You"].tap()
        XCTAssertEqual(rows.count, 1, "You shows the one sent")
        snap(app, "filter-you")
        app.buttons["All"].tap()

        app.buttons["Open island-panel.png"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["image-pager"].waitForExistence(timeout: 5), "the viewer did not open")
        sleep(2)
        snap(app, "image-viewer")
        app.buttons["Close"].tap()
        sleep(1)

        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Play '")).firstMatch.tap()
        sleep(3)
        snap(app, "video-player")
        let done = app.buttons.matching(NSPredicate(format: "label IN {'Close', 'Done', 'Close video'}")).firstMatch
        if done.waitForExistence(timeout: 5) { done.tap() } else { app.swipeDown() }
        sleep(1)

        let off = app.switches["Turn off PR watch"]
        XCTAssertTrue(off.waitForExistence(timeout: 5), "no switch on PR watch")
        off.tap()
        XCTAssertTrue(app.switches["Turn on PR watch"].waitForExistence(timeout: 5), "PR watch did not turn off")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Paused'")).firstMatch.exists)
        sleep(1)
        snap(app, "routine-paused")
        app.switches["Turn on PR watch"].tap()
        XCTAssertTrue(app.switches["Turn off PR watch"].waitForExistence(timeout: 5), "PR watch did not turn back on")

        let digest = routines.element(boundBy: 0)
        digest.press(forDuration: 1.2)
        let delete = app.buttons["Delete routine"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "no Delete in the long-press menu")
        snap(app, "routine-menu")
        delete.tap()
        let gone = NSPredicate(format: "count == 1")
        expectation(for: gone, evaluatedWith: routines)
        waitForExpectations(timeout: 10)
        sleep(1)
        snap(app, "routine-deleted")
    }

    private func connected() throws -> XCUIApplication {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()
        return app
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
