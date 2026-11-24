import XCTest

/// Settings › Open bot at launch: Off, a launch draws the list, even with one bot and
/// no tasks; a bot picked, a cold launch opens its chat as the first screen and Back is the list. Scratch servers beside a few tasks, one with
/// a bot (Ops) and one with three (Ops, Scout, Scribe), each chat saying "Hi." but Ops's in the first:
///   TEST_RUNNER_DRAY_ONE_URL=… TEST_RUNNER_DRAY_THREE_URL=… TEST_RUNNER_DRAY_TOKEN=…
final class LaunchBotTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testOff() throws {
        var app = try pair("DRAY_ONE_URL", ["-launch.bot", ""])
        XCTAssertTrue(app.staticTexts["Fix login redirect"].waitForExistence(timeout: 20), "no task rows")
        sleep(3)
        app = relaunch(app, ["-launch.bot", ""])
        sleep(6)
        XCTAssertTrue(app.buttons["Settings"].exists, "left the list with the setting off")
        snap("1-off-list")
        app.buttons["Settings"].tap()
        sleep(1)
        snap("2-off-settings")
    }

    /// One bot and no tasks used to open the bot by itself (#1169); Off, nothing does.
    /// `scripts/lone_bot_seed.py`'s `lone` home: TEST_RUNNER_DRAY_LONE_URL=…
    func testOffLoneBotStays() throws {
        var app = try pair("DRAY_LONE_URL", ["-launch.bot", ""])
        XCTAssertTrue(app.staticTexts["Ops"].waitForExistence(timeout: 20), "no bot row")
        sleep(3)
        app = relaunch(app, ["-launch.bot", ""])
        sleep(6)
        XCTAssertTrue(app.buttons["Settings"].exists, "the lone bot opened by itself")
        snap("0-off-lone-bot")
    }

    func testOnOneBot() throws {
        var app = try pair("DRAY_ONE_URL")
        XCTAssertTrue(app.staticTexts["Ops"].waitForExistence(timeout: 20), "no bot row")
        pick(app, "Ops")
        snap("3-on-one-settings")
        app.buttons["Done"].tap()
        sleep(3)
        app = relaunch(app)
        XCTAssertTrue(app.staticTexts["Morning. Nothing on fire."].waitForExistence(timeout: 15), "the bot's chat did not open")
        snap("4-on-one-opened")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5), "Back did not reach the list")
        snap("5-on-one-back")
    }

    func testOnSeveralBots() throws {
        var app = try pair("DRAY_THREE_URL")
        XCTAssertTrue(app.staticTexts["Scribe"].waitForExistence(timeout: 20), "no third bot")
        pick(app, "Scout")
        snap("7-on-several-picked")
        app.buttons["Done"].tap()
        sleep(3)
        app = relaunch(app)
        sleep(6)
        XCTAssertFalse(app.buttons["Settings"].exists, "stayed on the list")
        XCTAssertTrue(app.staticTexts["Scout"].exists, "opened a bot other than Scout")
        snap("8-on-several-opened")
    }

    /// Picks `name` from Settings' Open bot at launch, Off included.
    private func pick(_ app: XCUIApplication, _ name: String) {
        app.buttons["Settings"].tap()
        let row = labelled(app, "Open bot at launch")
        XCTAssertTrue(row.waitForExistence(timeout: 5), "no Open bot at launch row")
        row.tap()
        sleep(1)
        snap("menu-\(name)")
        app.buttons[name].firstMatch.tap()
        sleep(1)
    }

    private func relaunch(_ app: XCUIApplication, _ args: [String] = []) -> XCUIApplication {
        app.terminate()
        let next = XCUIApplication()
        next.launchArguments = args
        next.launch()
        return next
    }

    private func labelled(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
    }

    private func pair(_ urlKey: String, _ args: [String] = []) throws -> XCUIApplication {
        guard let url = env[urlKey], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""] + args
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        let open = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
        if open.waitForExistence(timeout: 5) { open.tap() }
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        // An earlier case may have left a bot picked, which opens it as the list comes in.
        sleep(8)
        if !app.buttons["Settings"].exists { app.navigationBars.buttons.firstMatch.tap() }
        return app
    }

    private func snap(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
