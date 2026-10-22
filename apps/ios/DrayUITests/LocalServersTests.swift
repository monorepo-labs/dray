import XCTest

/// Drives the Local servers sheet against a live `dray-serve` whose newest
/// session has a dev server running in its checkout, on `DRAY_PORT` (5544 if
/// unset) — `python3 -m http.server 5544` started in the session's `cwd` will
/// do. Passed through as in `SmokeTests`; `DRAY_SHARE` says what the share
/// should come to: `fail` for a refusal, anything else for a real link.
final class LocalServersTests: XCTestCase {
    func testListAndShare() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let expectFailure = env["DRAY_SHARE"] == "fail"
        let port = env["DRAY_PORT"] ?? "5544"
        let app = XCUIApplication()
        // Hides any saved servers, so the empty list's own Add server is the one on screen.
        app.launchArguments = ["-servers", ""]
        app.launch()

        app.buttons["Add server"].tap()
        app.textFields["Address"].tap()
        app.textFields["Address"].typeText(url)
        app.textFields["Token"].tap()
        app.textFields["Token"].typeText(token)
        app.buttons["Add"].tap()

        let row = app.collectionViews.cells.firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no session listed")
        row.tap()
        app.buttons["Local servers"].tap()

        let server = app.staticTexts["localhost:\(port)"]
        XCTAssertTrue(server.waitForExistence(timeout: 15), "the dev server is not listed")
        snap(app, "1-list")
        app.buttons["Get public link"].tap()
        snap(app, "2-creating")

        if expectFailure {
            let reason = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Could not set up the tunnel'")).firstMatch
            XCTAssertTrue(reason.waitForExistence(timeout: 30), "no failure sentence")
            snap(app, "3-failed")
            XCTAssertTrue(app.buttons["Get public link"].isEnabled, "no retry after a failure")
            return
        }

        let stalled = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'shows here once'")).firstMatch
        let copy = app.buttons["Copy link"]
        // Either the link lands inside half a minute, or the stall sentence shows.
        XCTAssertTrue(copy.waitForExistence(timeout: 40) || stalled.exists, "spinning with nothing to say")
        snap(app, "3-waiting-or-link")
        XCTAssertTrue(copy.waitForExistence(timeout: 420), "the share never answered")
        snap(app, "4-link")
        copy.tap()
        XCTAssertTrue(app.buttons["Copied"].waitForExistence(timeout: 3))
        app.buttons["Stop sharing"].tap()
        XCTAssertTrue(app.buttons["Get public link"].waitForExistence(timeout: 15), "stop left the link up")
        snap(app, "5-stopped")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
