import XCTest

/// The #825 image viewer against a real server whose session read three PNGs
/// in one turn: open, page by swipe, jump by thumbnail, pinch, drag down to close.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_TITLE=… xcodebuild test …
final class ImageViewerTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testViewer() throws {
        let app = try pair()
        let row = labelled(app, env["DRAY_TITLE"] ?? "")
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no session listed")
        row.tap()
        let open = app.buttons["Open image"].firstMatch
        XCTAssertTrue(open.waitForExistence(timeout: 15), "no image in the transcript")
        sleep(2)
        snap(app, "transcript")
        leftmost(app.buttons.matching(identifier: "Open image")).tap()

        let close = app.buttons["Close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "the viewer didn't open")
        XCTAssertTrue(app.staticTexts["1 of 3"].waitForExistence(timeout: 5))
        sleep(2)
        snap(app, "open")

        let pager = app.descendants(matching: .any)["image-pager"]
        pager.swipeLeft()
        XCTAssertTrue(app.staticTexts["2 of 3"].waitForExistence(timeout: 5), "swiping didn't page")
        sleep(2)
        snap(app, "paged")

        app.buttons["Image 3 of 3"].tap()
        XCTAssertTrue(app.staticTexts["3 of 3"].waitForExistence(timeout: 5), "the thumbnail didn't jump")
        sleep(2)
        snap(app, "jumped")

        pager.pinch(withScale: 3, velocity: 3)
        sleep(1)
        XCTAssertFalse(close.isHittable, "the chrome stayed while zoomed")
        snap(app, "zoomed")
        pager.pinch(withScale: 0.2, velocity: -3)
        XCTAssertTrue(close.waitForHittable(), "the chrome didn't come back")
        sleep(1)

        let from = pager.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        let to = pager.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        from.press(forDuration: 0.2, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.4)
        XCTAssertTrue(close.waitForNonExistence(timeout: 5), "dragging down didn't close")
        sleep(1)
        snap(app, "closed")
    }

    /// #1714: a bot whose reply holds four pictures, then a reply holding one. A tap pages
    /// the reply's own, opened on the one tapped; the lone one opens alone.
    ///   TEST_RUNNER_DRAY_BOT=<bot title>, with the URL and token above.
    func testBotReplyPages() throws {
        guard let bot = env["DRAY_BOT"] else { throw XCTSkip("set TEST_RUNNER_DRAY_BOT") }
        let app = try pair()
        let row = labelled(app, bot)
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no bot listed")
        row.tap()
        let opens = app.buttons.matching(identifier: "Open image")
        XCTAssertTrue(opens.element(boundBy: 4).waitForExistence(timeout: 15), "the chat drew fewer than five images")
        sleep(2)
        snap(app, "chat")
        func inOrder() -> [XCUIElement] { opens.allElementsBoundByIndex.sorted { $0.frame.midY < $1.frame.midY } }
        inOrder()[2].tap()

        let close = app.buttons["Close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "the viewer didn't open")
        XCTAssertTrue(app.staticTexts["3 of 4"].waitForExistence(timeout: 5), "didn't open on the third of four")
        sleep(1)
        snap(app, "third")
        app.descendants(matching: .any)["image-pager"].swipeLeft()
        XCTAssertTrue(app.staticTexts["4 of 4"].waitForExistence(timeout: 5), "swiping didn't page")
        sleep(1)
        app.buttons["Image 1 of 4"].tap()
        XCTAssertTrue(app.staticTexts["1 of 4"].waitForExistence(timeout: 5), "the strip didn't jump")
        sleep(1)
        snap(app, "first")
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))
        sleep(1)

        // The viewer opened on a picture scrolled up from the end, so the lone one sits below the fold.
        let lone = inOrder()[4]
        // Its centre still reads hittable under the dock, so scroll to the end regardless.
        app.scrollViews.firstMatch.swipeUp()
        app.scrollViews.firstMatch.swipeUp()
        sleep(1)
        lone.tap()
        XCTAssertTrue(close.waitForExistence(timeout: 5), "the lone image didn't open")
        sleep(1)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ' of 1'")).firstMatch.exists, "a lone image counts pages")
        XCTAssertFalse(app.buttons["Image 1 of 1"].exists, "a lone image draws a strip")
        snap(app, "alone")
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))
    }

    /// Shows a page whose picture the server can't send, for the failure state.
    func testFailure() throws {
        let app = try pair()
        let row = labelled(app, env["DRAY_TITLE"] ?? "")
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no session listed")
        row.tap()
        let open = app.buttons["Open image"].firstMatch
        XCTAssertTrue(open.waitForExistence(timeout: 15), "no image in the transcript")
        sleep(3)
        open.tap()
        app.buttons["Image 3 of 3"].tap()
        XCTAssertTrue(app.staticTexts["Couldn't load image"].waitForExistence(timeout: 10), "no failure state")
        sleep(1)
        snap(app, "failed")
    }

    /// The thumbnail row's accessibility order isn't its left-to-right order.
    func leftmost(_ query: XCUIElementQuery) -> XCUIElement {
        query.allElementsBoundByIndex.min { $0.frame.midX < $1.frame.midX }!
    }

    func labelled(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// A fresh launch with no saved server, paired through the link a QR carries.
    func pair() throws -> XCUIApplication {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Studio Mac")]
        app.open(link.url!)
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()
        return app
    }

    func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}

private extension XCUIElement {
    func waitForHittable(timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if exists && isHittable { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        return false
    }
}
