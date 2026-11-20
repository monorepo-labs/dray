import XCTest

/// Every inline recording offers full screen with the phone upright, a landscape one
/// as well as a portrait one (#1357). Against `scripts/image_retry_seed.py`'s home with
/// a landscape and a portrait recording added to the bot chat.
final class VideoFullScreenTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testBothOrientationsOfferFullScreen() throws {
        XCUIDevice.shared.orientation = .portrait
        let app = try pair()
        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Ops")).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 20), "no bot row")
        bot.tap()
        sleep(6)
        let videos = app.otherElements.matching(NSPredicate(format: "label == %@", "Video"))
        XCTAssertEqual(videos.count, 2, "not both recordings in the chat")
        // The landscape one sits above, so it is brought down onto the screen first.
        app.swipeDown()
        sleep(1)
        checkFullScreen(app, videos.element(boundBy: 0), "landscape")
        app.swipeUp()
        sleep(1)
        checkFullScreen(app, videos.element(boundBy: 1), "portrait")
    }

    /// Tapping the player shows its controls; one of them takes it full screen.
    private func checkFullScreen(_ app: XCUIApplication, _ video: XCUIElement, _ name: String) {
        video.tap()
        sleep(1)
        let frame = video.frame
        snap(app, "\(name)-controls")
        // AVKit's is "enter full screen", ours "Enter full screen": one of them, never both.
        let full = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "enter full screen"))
            .allElementsBoundByIndex.filter { frame.intersects($0.frame) }
        XCTAssertEqual(full.count, 1, "\(name): \(full.count) full screen buttons, want one")
        guard let button = full.first else { return }
        button.tap()
        // Full screen is AVKit's own presentation, closed by its X.
        sleep(2)
        snap(app, "\(name)-full-screen")
        let close = app.buttons["Close"]
        // Playing, AVKit hides its controls; a tap brings them back.
        if !close.exists { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        XCTAssertTrue(close.waitForExistence(timeout: 5), "\(name): never went full screen")
        guard close.exists else { return }
        close.tap()
        XCTAssertTrue(app.buttons["BackButton"].waitForExistence(timeout: 5), "\(name): full screen never closed")
        sleep(1)
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
