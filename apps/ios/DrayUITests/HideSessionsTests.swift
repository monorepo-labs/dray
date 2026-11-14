import XCTest

/// #1103: Settings › Appearance › Hide sessions leaves the list to bots, and a
/// server with projects but no tasks draws no project strip. Each wants a scratch
/// server with a bot and two projects, the first with tasks in both, the second with none.
/// The switch flipped is kept, so the first wants a simulator where it is still off:
///   TEST_RUNNER_DRAY_URL=… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_EMPTY_URL=… TEST_RUNNER_DRAY_EMPTY_TOKEN=…
final class HideSessionsTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testHideSessions() throws {
        let app = try pair(env["DRAY_URL"], env["DRAY_TOKEN"])
        XCTAssertTrue(app.staticTexts["Fix login redirect"].waitForExistence(timeout: 20), "no session rows")
        XCTAssertTrue(app.buttons["alpha-site"].exists, "no project strip")
        snap(app, "1-sessions-shown")

        app.buttons["Settings"].tap()
        labelled(app, "Appearance").tap()
        labelled(app, "Hide sessions").tap()
        sleep(1)
        snap(app, "2-appearance")
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Done"].tap()

        XCTAssertTrue(app.staticTexts["Ops"].waitForExistence(timeout: 5), "the bot went too")
        XCTAssertFalse(app.staticTexts["Fix login redirect"].exists, "a session still shows")
        XCTAssertFalse(app.buttons["alpha-site"].exists, "the project strip still shows")
        XCTAssertFalse(app.buttons["Keyboard"].exists, "the dock still shows")
        sleep(1)
        snap(app, "3-bots-only")
    }

    func testNoTasksNoStrip() throws {
        // Pinned off, whatever an earlier run of the first test left it at.
        let app = try pair(env["DRAY_EMPTY_URL"], env["DRAY_EMPTY_TOKEN"], ["-list.hideSessions", "NO"])
        XCTAssertTrue(app.staticTexts["Ops"].waitForExistence(timeout: 20), "no bot row")
        sleep(2)
        XCTAssertFalse(app.buttons["alpha-site"].exists, "a strip with no tasks")
        snap(app, "4-no-tasks")
    }

    private func pair(_ url: String?, _ token: String?, _ args: [String] = []) throws -> XCUIApplication {
        guard let url, let token else { throw XCTSkip("no server") }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""] + args
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        return app
    }

    private func labelled(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
