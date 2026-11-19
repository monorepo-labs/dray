import XCTest

/// A tap on a bot's row opens its chat, with one bot and with several.
/// Servers seeded by `scripts/lone_bot_seed.py`:
///   TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_LONE_URL=ws://127.0.0.1:47211 TEST_RUNNER_DRAY_TWO_URL=…:47212
///   TEST_RUNNER_DRAY_VISIBLE_URL=…:47213
final class BotTapTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testTapOneOfTwoBots() throws {
        let app = try paired("DRAY_TWO_URL")
        app.staticTexts["Scout"].tap()
        opened(app, "Scout")
        back(app)
        app.staticTexts["Ops"].tap()
        opened(app, "Ops")
    }

    /// Back from the lone bot the launch opened, then its row again.
    func testTapLoneBotAfterBack() throws {
        let app = try paired("DRAY_LONE_URL")
        app.terminate()
        app.launchArguments = ["-list.hideSessions", "NO"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Morning. Nothing on fire."].waitForExistence(timeout: 15), "the chat did not open")
        back(app)
        app.staticTexts["Ops"].tap()
        opened(app, "Ops")
    }

    func testTapBotBesideSession() throws {
        let app = try paired("DRAY_VISIBLE_URL")
        app.staticTexts["Ops"].tap()
        opened(app, "Ops")
        back(app)
        app.staticTexts["Fix login redirect"].tap()
        opened(app, "Fix login redirect")
    }

    /// The list is gone and that chat is up: the seed's prompt is its title and a "?", drawn only in the chat.
    private func opened(_ app: XCUIApplication, _ what: String) {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["Settings"])
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 5), .completed, "\(what) did not open")
        XCTAssertTrue(app.staticTexts["\(what)?"].waitForExistence(timeout: 5), "not \(what)'s chat")
    }

    private func back(_ app: XCUIApplication) {
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5), "Back did not reach the list")
    }

    private func paired(_ urlKey: String) throws -> XCUIApplication {
        guard let url = env[urlKey], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-list.hideSessions", "NO"]
        app.launch()
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        XCTAssertTrue(app.staticTexts["Ops"].waitForExistence(timeout: 15), "no bot row after pairing")
        sleep(3)
        return app
    }
}
