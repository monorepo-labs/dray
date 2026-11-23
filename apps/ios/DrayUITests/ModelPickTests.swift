import XCTest

/// #1455 against a real server and real turns: a model picked for a reply stays on the dock once
/// the reply is sent, and on opening the chat again — a task's This task sheet, a bot chat's, and
/// the Edit bot sheet's agent and model.
///   TEST_RUNNER_DRAY_URL=ws://… TEST_RUNNER_DRAY_TOKEN=… xcodebuild test -only-testing:DrayUITests/ModelPickTests
/// The server holds a task "Model test" and a bot "Otter", both Claude Code on Haiku 5.5 at Low.
final class ModelPickTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }
    private let haiku = "Haiku 5.5", sonnet = "Sonnet 5.5"

    func test1Task() throws {
        let app = try open("Model test")
        sendOn(app, sonnet)
        reopen(app, "Model test", sonnet)
        sendOn(app, haiku)
    }

    func test2BotDock() throws {
        let app = try open("Otter")
        sendOn(app, sonnet)
        reopen(app, "Otter", sonnet)
    }

    func test3BotSheet() throws {
        let app = try open("Otter")
        app.buttons["botChip"].tap()
        let chip = app.buttons[haiku]
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "Edit bot listed no models")
        chip.tap()
        app.buttons["Save"].tap()
        XCTAssertTrue(waitForModel(app, haiku, timeout: 10), "the dock never took the bot sheet's pick")
        reply(app)
        XCTAssertTrue(waitForModel(app, haiku, timeout: 5))
        reopen(app, "Otter", haiku)
    }

    // MARK: Helpers

    /// This task → `model`, then a reply; the dock names `model` after the send and after the turn.
    private func sendOn(_ app: XCUIApplication, _ model: String) {
        app.buttons["Model"].tap()
        let chip = app.buttons[model]
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "This task listed no \(model)")
        chip.tap()
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        sleep(1)
        XCTAssertEqual(modelShown(app), model, "the pick never reached the dock")
        reply(app)
        snap(app, "sent-\(model)")
        XCTAssertEqual(modelShown(app), model, "the dock went back after the send")
    }

    /// Sends, then waits out the turn.
    private func reply(_ app: XCUIApplication) {
        app.reply("Reply with the word ok and nothing else.")
        _ = app.buttons["Stop"].waitForExistence(timeout: 15)
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["Stop"])
        wait(for: [gone], timeout: 120)
        sleep(2)
    }

    private func reopen(_ app: XCUIApplication, _ row: String, _ model: String) {
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let item = app.staticTexts[row].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 10))
        item.tap()
        XCTAssertTrue(app.dock.waitForExistence(timeout: 15))
        XCTAssertTrue(waitForModel(app, model, timeout: 5), "reopened on \(modelShown(app)), not \(model)")
        snap(app, "reopened-\(model)")
    }

    private func modelShown(_ app: XCUIApplication) -> String { app.buttons["Model"].value as? String ?? "" }

    private func waitForModel(_ app: XCUIApplication, _ model: String, timeout: TimeInterval) -> Bool {
        let shown = expectation(for: NSPredicate(format: "value == %@", model), evaluatedWith: app.buttons["Model"])
        return XCTWaiter().wait(for: [shown], timeout: timeout) == .completed
    }

    private func open(_ row: String) throws -> XCUIApplication {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-shortlist.claude_code", "(\"haiku\", \"sonnet\")"]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        let item = app.staticTexts[row].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 20), "no row \(row)")
        item.tap()
        XCTAssertTrue(app.dock.waitForExistence(timeout: 15))
        sleep(2)
        return app
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
