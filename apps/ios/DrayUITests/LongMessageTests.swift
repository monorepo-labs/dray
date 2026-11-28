import XCTest

/// #1594 against a real server seeded by `scripts/long_message_seed.py`: a pasted wall
/// clamps with Show more, opens and closes again; a short prompt gets no button.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=…
///   xcodebuild test -only-testing:DrayUITests/LongMessageTests
final class LongMessageTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testLongMessageClamps() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()

        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Login crash")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no task")
        row.tap()

        let more = app.buttons["Show more"]
        XCTAssertTrue(more.waitForExistence(timeout: 20), "a forty-line paste drew no Show more")
        XCTAssertEqual(app.buttons.matching(identifier: "Show more").count, 1, "the short prompt clamped too")
        // Scrolled to the paste's top, so the shot shows the clamp itself.
        app.swipeDown(); app.swipeDown()
        sleep(1)
        snap(app, "clamped")

        more.tap()
        let less = app.buttons["Show less"]
        XCTAssertTrue(less.waitForExistence(timeout: 5), "Show more opened onto no Show less")
        sleep(1)
        snap(app, "open")
        // Hittable is not enough: under the composer's fade it still answers, and the tap lands on the dock.
        for _ in 0..<8 where less.frame.maxY > app.frame.height * 0.6 { app.swipeUp(velocity: .slow) }
        sleep(1)
        snap(app, "open-end")

        less.tap()
        XCTAssertTrue(app.buttons["Show more"].waitForExistence(timeout: 5), "Show less left no Show more")
        sleep(1)
        snap(app, "closed-again")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
