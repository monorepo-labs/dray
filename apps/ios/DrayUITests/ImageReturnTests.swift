import XCTest

/// A bot chat's markdown images show again on every return, not only the first open (#1357):
/// back out and reopen, go to the background and come back, then a relaunch, which reads
/// them from the server again since nothing is kept on the device. Against the same home as
/// `ImageRetryTests`: `scripts/image_retry_seed.py` behind `scripts/late_turns_proxy.py`.
final class ImageReturnTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testImagesShowOnEveryReturn() throws {
        var app = try pair()
        openBot(app)
        sleep(6)
        check(app, "1-first-open")

        back(app)
        openBot(app)
        sleep(2)
        check(app, "2-reopened")

        XCUIDevice.shared.press(.home)
        sleep(40)
        app.activate()
        sleep(3)
        check(app, "3-back-from-background")
        back(app)
        openBot(app)
        sleep(3)
        check(app, "4-reopened-after-background")

        app.terminate()
        app = XCUIApplication()
        app.launch()
        openBot(app)
        sleep(6)
        check(app, "5-relaunched")
    }

    private func openBot(_ app: XCUIApplication) {
        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Ops")).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 20), "no bot row")
        bot.tap()
        XCTAssertTrue(app.buttons["Open image"].firstMatch.waitForExistence(timeout: 15), "no image in the chat")
    }

    private func back(_ app: XCUIApplication) {
        app.navigationBars.buttons.element(boundBy: 0).tap()
        sleep(1)
    }

    /// Every picture on screen drawn, read off the pixels: each seeded shot is a saturated
    /// colour, where the stand-in is a faint grey box and a failed one its path in text.
    private func check(_ app: XCUIApplication, _ name: String) {
        let shot = app.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)

        let window = app.windows.firstMatch.frame
        let visible = app.buttons.matching(identifier: "Open image").allElementsBoundByIndex
            .map(\.frame).filter { $0.height > 30 && window.contains(CGPoint(x: $0.midX, y: $0.minY + $0.height * 0.2)) }
        XCTAssertFalse(visible.isEmpty, "\(name): no picture on screen")
        for (i, frame) in visible.enumerated() {
            let point = CGPoint(x: frame.midX, y: frame.minY + frame.height * 0.2)
            XCTAssertTrue(saturated(shot.image, at: point), "\(name): picture \(i + 1) on screen never drew")
        }
    }

    private func saturated(_ image: UIImage, at point: CGPoint) -> Bool {
        guard let cg = image.cgImage else { return false }
        let scale = CGFloat(cg.width) / image.size.width
        var px = [UInt8](repeating: 0, count: 4)
        let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: -point.x * scale, y: -(CGFloat(cg.height) - point.y * scale),
                                width: CGFloat(cg.width), height: CGFloat(cg.height)))
        let rgb = px[0..<3].map(Int.init)
        return rgb.max()! - rgb.min()! > 60
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
}
