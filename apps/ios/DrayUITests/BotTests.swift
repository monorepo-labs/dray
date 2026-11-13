import XCTest

/// #996 against a real server holding a bot with tasks: the bot's inbox row,
/// its chat, its tasks sheet, a task opened over it and Back to the bot. Then,
/// with the server stopped, a cold launch drawing everything from the cache.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=Ops xcodebuild test …
final class BotTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testBotChatAndTasks() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let name = env["DRAY_BOT"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN and TEST_RUNNER_DRAY_BOT")
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

        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 20), "no bot row")
        sleep(2)
        snap(app, "list")
        bot.tap()
        sleep(3)
        snap(app, "bot-chat")
        app.buttons["Tasks"].tap()
        sleep(1)
        snap(app, "bot-tasks")
        let task = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "README")).firstMatch
        XCTAssertTrue(task.waitForExistence(timeout: 5), "no task in the sheet")
        task.tap()
        sleep(3)
        snap(app, "task-over-bot")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["Tasks"].waitForExistence(timeout: 5), "Back did not return to the bot")
        snap(app, "back-to-bot")
    }

    /// Run with the server stopped: the list and the bot's chat come from the cache, with no banner.
    func testColdOpenFromCache() throws {
        guard let name = env["DRAY_BOT"] else { throw XCTSkip("set TEST_RUNNER_DRAY_BOT") }
        let app = XCUIApplication()
        app.launch()
        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 3), "the cached list did not draw at once")
        snap(app, "cold-list")
        bot.tap()
        sleep(1)
        snap(app, "cold-bot-chat")
        sleep(12)
        snap(app, "cold-bot-chat-lost")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
