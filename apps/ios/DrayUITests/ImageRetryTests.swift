import XCTest

/// A bot chat's markdown images load inline once their server is back, without a tap (#1347):
/// opened cold from the cache while the server is out of reach, staying on screen, and
/// then going to the background through it. Against `scripts/image_retry_seed.py`'s
/// home behind `scripts/late_turns_proxy.py`:
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:<proxy> TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_PROXY=http://127.0.0.1:<proxy> xcodebuild test …
final class ImageRetryTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testImagesLoadOnceTheServerIsBack() throws {
        guard let proxy = env["DRAY_PROXY"] else { throw XCTSkip("set TEST_RUNNER_DRAY_PROXY") }
        var app = try pair()
        openBot(app)
        sleep(6)
        snap(app, "1-first-open")
        app.terminate()

        // Out of reach for longer than the inline loader used to keep trying.
        try down(proxy, 40)
        app = XCUIApplication()
        app.launch()
        openBot(app)
        sleep(3)
        snap(app, "2-cold-server-down")
        waitConnected(app)
        snap(app, "3-cold-server-back")
        app.terminate()

        try down(proxy, 30)
        app = XCUIApplication()
        app.launch()
        openBot(app)
        sleep(2)
        XCUIDevice.shared.press(.home)
        sleep(45)
        app.activate()
        waitConnected(app)
        snap(app, "4-back-from-background")
        app.windows.firstMatch.swipeDown()
        sleep(2)
        snap(app, "5-scrolled-back")
    }

    private func openBot(_ app: XCUIApplication) {
        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Ops")).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 20), "no bot row")
        bot.tap()
        XCTAssertTrue(app.buttons["Open image"].firstMatch.waitForExistence(timeout: 15), "no image in the chat")
    }

    /// The reconnect's banner gone, then time for the pictures to land.
    private func waitConnected(_ app: XCUIApplication) {
        sleep(3)
        let banner = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "reach Test Mac")).firstMatch
        XCTAssertTrue(banner.waitForNonExistence(timeout: 120), "never reconnected")
        sleep(10)
    }

    private func down(_ proxy: String, _ seconds: Int) throws {
        _ = try Data(contentsOf: URL(string: "\(proxy)/down?for=\(seconds)")!)
    }

    private func pair() throws -> XCUIApplication {
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
