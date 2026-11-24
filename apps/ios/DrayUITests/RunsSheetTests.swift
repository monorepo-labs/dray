import XCTest

/// The background line opens the runs: a task's own sheet, a bot's Tasks sheet. Needs a live
/// server holding a task titled "Runs task" and a bot named "Runner", each with a finished
/// subagent, a running one and a running background shell:
///   TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_RUNS_URL=ws://127.0.0.1:47221
final class RunsSheetTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testTaskAndBotRuns() throws {
        let app = try paired()

        app.staticTexts["Runs task"].firstMatch.tap()
        try check(app, "task")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        XCTAssertTrue(app.staticTexts["Runner"].firstMatch.waitForExistence(timeout: 5), "no bot row")
        app.staticTexts["Runner"].firstMatch.tap()
        try check(app, "bot")
    }

    /// Opens the sheet off the line, the shell's output, then the finished subagents.
    private func check(_ app: XCUIApplication, _ name: String) throws {
        let line = app.buttons["backgroundTasks"]
        XCTAssertTrue(line.waitForExistence(timeout: 20), "\(name): no background line")
        sleep(1)
        line.tap()
        XCTAssertTrue(app.buttons["Background tasks"].waitForExistence(timeout: 5), "\(name): no shells section")
        // A bot's runs sit under its tasks.
        if name == "bot" { XCTAssertTrue(app.navigationBars["Tasks"].exists, "the bot's line opened no Tasks sheet") }
        XCTAssertTrue(app.buttons["Subagents"].exists, "\(name): no subagents section")
        XCTAssertTrue(app.staticTexts["Slow watcher"].firstMatch.exists, "\(name): running subagent not shown")
        XCTAssertFalse(app.staticTexts["List root folder"].firstMatch.exists, "\(name): finished subagent not folded")
        sleep(2)
        snap(app, "\(name)-1-sheet")

        app.staticTexts["Tick log"].firstMatch.tap()
        let output = app.descendants(matching: .any)["runOutput"]
        XCTAssertTrue(output.waitForExistence(timeout: 8), "\(name): no shell output")
        sleep(3)
        snap(app, "\(name)-2-shell")
        app.staticTexts["Tick log"].firstMatch.tap()

        app.buttons["Show completed subagents"].tap()
        XCTAssertTrue(app.staticTexts["List root folder"].firstMatch.waitForExistence(timeout: 3), "\(name): finished subagent not listed")
        sleep(1)
        snap(app, "\(name)-3-completed")

        // A running Claude subagent opens as a chat of its own, then Back returns to the chat under it.
        app.staticTexts["Slow watcher"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Slow watcher"].waitForExistence(timeout: 5), "\(name): subagent chat did not open")
        sleep(3)
        snap(app, "\(name)-4-subagent-chat")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["backgroundTasks"].waitForExistence(timeout: 5), "\(name): Back did not return to the chat")
    }

    private func paired() throws -> XCUIApplication {
        guard let url = env["DRAY_RUNS_URL"], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        XCTAssertTrue(app.staticTexts["Runner"].firstMatch.waitForExistence(timeout: 15), "no bot row after pairing")
        return app
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
