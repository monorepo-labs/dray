import XCTest

/// A bot chat after the app sat in the background while its socket died under it,
/// the server's side gone and the phone's still open and silent. Run against a
/// real server behind `scripts/freeze_proxy.py`, whose freeze command starts a
/// turn in `DRAY_BOT`'s chat that first says `DRAY_PHRASE` and then
/// keeps working, and with that chat holding "Reply 6" from before:
///   freeze_proxy.py 50300 <server port> 50301 'dray bot send "<bot>" "…"'
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:50300 TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=<bot>
///   TEST_RUNNER_DRAY_PHRASE=… TEST_RUNNER_DRAY_CONTROL=http://127.0.0.1:50301 xcodebuild test -only-testing:DrayUITests/StaleSocketTests
final class StaleSocketTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    /// Back at the front, the chat holds what was said while away and the turn still running.
    func testForegroundRevivesHalfDeadSocket() throws {
        let (app, bot) = try openBot()
        bot.tap()
        XCTAssertTrue(text(app, "Reply 6").waitForExistence(timeout: 20), "the chat's history never drew")
        snap(app, "before-background")

        XCUIDevice.shared.press(.home)
        try control("freeze")
        // Long enough for the turn to say its first line, short of the 25s ping finding the socket dead.
        sleep(12)
        app.activate()
        sleep(2)
        snap(app, "foreground-2s")
        XCTAssertTrue(text(app, env["DRAY_PHRASE"] ?? "Night shift started").waitForExistence(timeout: 15),
                      "what the bot said while the app was away never came in")
        snap(app, "foreground-caught-up")
    }

    /// The first open since launch says it is reading; the next open of the same chat does not.
    func testReadingLatestMessagesOncePerLaunch() throws {
        let (app, bot) = try openBot()
        try control("slow?ms=1500")
        defer { try? control("slow?ms=0") }
        bot.tap()
        let reading = app.staticTexts["Reading latest messages"]
        XCTAssertTrue(reading.waitForExistence(timeout: 10), "no reading line on the first open")
        snap(app, "first-open-reading")
        XCTAssertTrue(reading.waitForNonExistence(timeout: 40), "the reading line never went")
        snap(app, "first-open-read")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(bot.waitForExistence(timeout: 5))
        bot.tap()
        XCTAssertFalse(reading.waitForExistence(timeout: 3), "the reading line came back on a second open")
        snap(app, "second-open")
    }

    private func openBot() throws -> (XCUIApplication, XCUIElement) {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let name = env["DRAY_BOT"], env["DRAY_CONTROL"] != nil else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, _TOKEN, _BOT and _CONTROL")
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
        return (app, bot)
    }

    private func text(_ app: XCUIApplication, _ s: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", s)).firstMatch
    }

    /// One of the proxy's routes, answered before going on.
    private func control(_ route: String) throws {
        let url = URL(string: "\(env["DRAY_CONTROL"]!)/\(route)")!
        let done = expectation(description: route)
        URLSession.shared.dataTask(with: url) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 5)
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
