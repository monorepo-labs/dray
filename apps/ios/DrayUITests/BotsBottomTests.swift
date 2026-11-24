import XCTest

/// Bots sit under the new-task dock, in the thumb's reach. Each case wants a
/// scratch server beside a few tasks, one with a bot and one with three:
///   TEST_RUNNER_DRAY_ONE_URL=… TEST_RUNNER_DRAY_THREE_URL=… TEST_RUNNER_DRAY_TOKEN=…
final class BotsBottomTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testOneBot() throws {
        let app = try pair("DRAY_ONE_URL")
        let ops = app.staticTexts["Ops"]
        XCTAssertTrue(ops.waitForExistence(timeout: 20), "no bot row")
        XCTAssertTrue(app.staticTexts["Fix login redirect"].waitForExistence(timeout: 10), "no task rows")
        sleep(2)
        let orb = app.buttons["Keyboard"]
        XCTAssertGreaterThan(ops.frame.minY, app.staticTexts["Fix login redirect"].frame.maxY, "the bot is not under the tasks")
        snap(app, "1-one-bot")

        // The keyboard: the bot steps aside so the words sit on it.
        if orb.exists { orb.tap() } else { app.swipeUp() }
        sleep(2)
        snap(app, "2-one-bot-keyboard")
        app.buttons["Done"].firstMatch.tap()
        sleep(2)
        XCTAssertTrue(ops.waitForExistence(timeout: 5), "the bot did not come back")

        ops.tap()
        XCTAssertTrue(app.staticTexts["Morning. Nothing on fire."].waitForExistence(timeout: 10), "the bot's chat did not open")
        snap(app, "3-one-bot-chat")
    }

    func testThreeBots() throws {
        let app = try pair("DRAY_THREE_URL")
        XCTAssertTrue(app.staticTexts["Scribe"].waitForExistence(timeout: 20), "no third bot")
        sleep(2)
        snap(app, "4-three-bots")
        app.swipeUp()
        sleep(1)
        snap(app, "5-three-bots-scrolled")
    }

    private func pair(_ urlKey: String) throws -> XCUIApplication {
        guard let url = env[urlKey], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        let open = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
        if open.waitForExistence(timeout: 5) { open.tap() }
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        return app
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
