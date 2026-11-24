import XCTest

/// #1103: a server with projects but no tasks draws no project strip. Wants a
/// scratch server with a bot and two projects and no tasks:
///   TEST_RUNNER_DRAY_EMPTY_URL=… TEST_RUNNER_DRAY_EMPTY_TOKEN=…
final class NoTasksStripTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testNoTasksNoStrip() throws {
        guard let url = env["DRAY_EMPTY_URL"], let token = env["DRAY_EMPTY_TOKEN"] else { throw XCTSkip("no server") }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        XCTAssertTrue(app.staticTexts["Ops"].waitForExistence(timeout: 20), "no bot row")
        sleep(2)
        XCTAssertFalse(app.buttons["alpha-site"].exists, "a strip with no tasks")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "no-tasks"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
