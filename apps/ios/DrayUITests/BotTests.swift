import XCTest

/// #996 against a real server holding a bot with tasks: the bot's inbox row,
/// its chat, its tasks sheet, a task opened over it and Back to the bot. Then,
/// with the server stopped, a cold launch drawing everything from the cache.
/// Then Greptile's round on #1007: a bot with no chat yet, and a chat across an agent switch.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=Ops xcodebuild test …
final class BotTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testBotChatAndTasks() throws {
        guard let name = env["DRAY_BOT"] else { throw XCTSkip("set TEST_RUNNER_DRAY_BOT") }
        let app = try connected()
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

    /// Needs a bot with no chat yet ("Dray Bot", carrying a welcome) and one whose
    /// chat has an earlier session on another agent (`DRAY_BOT`): the first's row
    /// aims the dock at it, and paging up the second reaches past the switch.
    func testFreshBotAndAgentSwitch() throws {
        guard let name = env["DRAY_BOT"] else { throw XCTSkip("set TEST_RUNNER_DRAY_BOT") }
        let app = try connected()
        let fresh = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Dray Bot")).firstMatch
        XCTAssertTrue(fresh.waitForExistence(timeout: 20), "a bot with no chat drew no row")
        sleep(2)
        snap(app, "fresh-bot-row")
        fresh.tap()
        XCTAssertTrue(app.staticTexts["Dray Bot"].waitForExistence(timeout: 5), "the dock did not aim at the bot")
        snap(app, "dock-aimed-at-bot")

        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        bot.tap()
        sleep(3)
        let switched = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Switched to")).firstMatch
        let earlier = app.buttons["Load earlier"]
        for _ in 0..<6 where !switched.exists {
            app.scrollViews.firstMatch.swipeDown(velocity: .fast)
            if earlier.waitForExistence(timeout: 2) { earlier.tap(); sleep(2) }
        }
        XCTAssertTrue(switched.exists, "paging up never reached the earlier session")
        snap(app, "agent-switch")
    }

    /// A fresh app paired to the test server through its link.
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
