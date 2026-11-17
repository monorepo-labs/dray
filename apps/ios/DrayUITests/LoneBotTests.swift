import XCTest

/// #1169: a cold launch where one bot is all the list would draw opens its chat.
/// Each case wants a scratch server of its own on one token, seeded by `/tmp/dray1169-seed.py`:
///   TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_LONE_URL=… TEST_RUNNER_DRAY_HIDDEN_URL=…
///   TEST_RUNNER_DRAY_VISIBLE_URL=… TEST_RUNNER_DRAY_TWO_URL=… TEST_RUNNER_DRAY_FRESH_URL=…
final class LoneBotTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    /// Its chat opens, Back goes to the list, and coming back from the background stays there.
    func testLoneBotOpens() throws {
        let app = try coldLaunch("DRAY_LONE_URL")
        XCTAssertTrue(app.staticTexts["Morning. Nothing on fire."].waitForExistence(timeout: 15), "the chat did not open")
        XCTAssertFalse(app.buttons["Settings"].exists, "still on the list")
        snap(app, "1-lone-opened")

        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5), "Back did not reach the list")
        XCUIDevice.shared.press(.home)
        sleep(2)
        app.activate()
        sleep(4)
        XCTAssertTrue(app.buttons["Settings"].exists, "the chat opened again from the background")
        snap(app, "2-lone-back-from-background")
    }

    func testOnlyHiddenTasksOpens() throws {
        let app = try coldLaunch("DRAY_HIDDEN_URL")
        XCTAssertTrue(app.staticTexts["Two tasks running for you."].waitForExistence(timeout: 15), "the chat did not open")
        snap(app, "3-hidden-opened")
    }

    func testVisibleSessionStays() throws {
        let app = try coldLaunch("DRAY_VISIBLE_URL")
        XCTAssertTrue(app.staticTexts["Fix login redirect"].waitForExistence(timeout: 15), "no session row")
        sleep(4)
        XCTAssertTrue(app.buttons["Settings"].exists, "left the list")
        snap(app, "4-visible-stays")
    }

    func testTwoBotsStay() throws {
        let app = try coldLaunch("DRAY_TWO_URL")
        XCTAssertTrue(app.staticTexts["Scout"].waitForExistence(timeout: 15), "no second bot")
        sleep(4)
        XCTAssertTrue(app.buttons["Settings"].exists, "left the list")
        snap(app, "5-two-stay")
    }

    /// Settings › Hide sessions leaves the bot alone on the list, whatever sessions there are.
    func testHideSessionsOpens() throws {
        let app = try coldLaunch("DRAY_VISIBLE_URL", hide: true)
        XCTAssertTrue(app.staticTexts["Hi."].waitForExistence(timeout: 15), "the chat did not open")
        snap(app, "7-hide-sessions-opened")
    }

    /// No chat yet: the bot's own page, with the dock aimed at it.
    func testFreshBotOpensItsPage() throws {
        let app = try coldLaunch("DRAY_FRESH_URL")
        XCTAssertTrue(app.buttons["Keyboard"].waitForExistence(timeout: 15), "no dock")
        sleep(2)
        XCTAssertFalse(app.buttons["Settings"].exists, "still on the list")
        snap(app, "6-fresh-page")
    }

    /// A pairing link that launches the app leaves its sheet over the list, not over the bot.
    func testLinkLaunchStays() throws {
        let app = try paired("DRAY_LONE_URL")
        app.terminate()
        app.open(try link("DRAY_TWO_URL"))
        let open = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
        if open.waitForExistence(timeout: 5) { open.tap() }
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 15), "the link opened no add sheet")
        sleep(3)
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5), "the link opened the bot")
        snap(app, "8-link-launch-stays")
    }

    private func link(_ urlKey: String) throws -> URL {
        guard let url = env[urlKey], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        return link.url!
    }

    /// Pairs the one server through a link, which opens nothing on its own, then launches cold.
    private func coldLaunch(_ urlKey: String, hide: Bool = false) throws -> XCUIApplication {
        let app = try paired(urlKey)
        app.terminate()
        app.launchArguments = ["-list.hideSessions", hide ? "YES" : "NO"]
        app.launch()
        return app
    }

    /// The app holding that one server, its list read and cached.
    private func paired(_ urlKey: String) throws -> XCUIApplication {
        let url = try link(urlKey)
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-list.hideSessions", "NO"]
        app.launch()
        app.open(url)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        XCTAssertTrue(app.staticTexts["Ops"].waitForExistence(timeout: 15), "no bot row after pairing")
        XCTAssertTrue(app.buttons["Settings"].exists, "pairing opened the bot")
        // The list's cache is written two seconds after it settles; the cold launch draws from it.
        sleep(3)
        return app
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
