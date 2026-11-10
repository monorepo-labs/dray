import XCTest

/// Drives the Local servers sheet against a live `dray-serve` through all four
/// states. Needs two sessions there: `DRAY_EMPTY` titles one with no dev
/// server, `DRAY_DEV` one with servers on `DRAY_PORTS` (comma-separated) in
/// its checkout — `python3 -m http.server 5544` started in its `cwd` will do.
/// `DRAY_KILL_FILE`, where set, is written once the share is done; whatever
/// watches it stops the server, and the sheet is opened again to show the error.
///   TEST_RUNNER_DRAY_URL=ws://… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_EMPTY=… xcodebuild test …
final class LocalServersTests: XCTestCase {
    func testStates() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"],
              let empty = env["DRAY_EMPTY"], let dev = env["DRAY_DEV"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, _TOKEN, _EMPTY and _DEV")
        }
        let ports = (env["DRAY_PORTS"] ?? "5544").split(separator: ",").map(String.init)
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Studio Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()

        open(app, empty)
        XCTAssertTrue(app.staticTexts["No servers running"].waitForExistence(timeout: 15))
        snap(app, "03-empty")
        app.buttons["Done"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        open(app, dev)
        for port in ports {
            XCTAssertTrue(app.staticTexts["localhost:\(port)"].waitForExistence(timeout: 15), "\(port) is not listed")
        }
        snap(app, "00-list")
        app.buttons["Get public link"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH '…'")).firstMatch.waitForExistence(timeout: 5))
        snap(app, "02-creating")
        let copy = app.buttons["Copy link"]
        let stalled = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'shows here once'")).firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 40) || stalled.exists, "spinning with nothing to say")
        if stalled.exists { snap(app, "02-waiting") }
        XCTAssertTrue(copy.waitForExistence(timeout: 420), "the share never answered")
        snap(app, "01-shared")
        copy.tap()
        XCTAssertTrue(app.buttons["Copied"].waitForExistence(timeout: 3))
        app.buttons["Stop sharing"].tap()
        XCTAssertTrue(app.buttons["Copy link"].waitForNonExistence(timeout: 15), "stop left the link up")
        app.buttons["Done"].tap()

        guard let kill = env["DRAY_KILL_FILE"] else { return }
        FileManager.default.createFile(atPath: kill, contents: nil)
        let failed = app.staticTexts["Couldn't list servers"]
        for _ in 0..<12 where !failed.exists {
            sleep(5)
            app.buttons["Local servers"].tap()
            if failed.waitForExistence(timeout: 3) { break }
            app.buttons["Done"].tap()
        }
        XCTAssertTrue(failed.exists, "a dead server never read as an error")
        snap(app, "04-error")
    }

    /// The newest session's dev server on `DRAY_PORT` (5544 if unset), paired by
    /// typing the address. `DRAY_SHARE` says what the share should come to:
    /// `fail` for a refusal, anything else for a real link.
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

        app.buttons["Enter an address"].tap()
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

    private func open(_ app: XCUIApplication, _ title: String) {
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "\(title) is not listed")
        row.tap()
        app.buttons["Local servers"].tap()
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
