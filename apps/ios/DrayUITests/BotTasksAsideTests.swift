import XCTest

/// A bot's Tasks sheet groups as the desktop's Tasks tab does: Pinned under its heading, a run per
/// state with a break between, set aside last. Needs a live server holding a bot named "Aside Bot"
/// whose task "Active one" is pinned, "Active two", "Idle three" and "Idle four" are idle,
/// "Working task" runs a background shell, and "Parked alpha" and "Parked beta" are set aside:
///   TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_ASIDE_URL=ws://127.0.0.1:47231
final class BotTasksAsideTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testTaskRuns() throws {
        guard let url = env["DRAY_ASIDE_URL"], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()

        let bot = app.staticTexts["Aside Bot"].firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 15), "no bot row after pairing")
        bot.tap()
        let tasks = app.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 10), "no Tasks button")
        tasks.tap()
        XCTAssertTrue(app.navigationBars["Tasks"].waitForExistence(timeout: 5), "no Tasks sheet")
        sleep(2)
        app.swipeUp() // the large detent, so every run is on screen
        sleep(1)

        let y = { (title: String) in app.buttons.matching(identifier: "botTask").containing(.staticText, identifier: title).firstMatch.frame.minY }
        let pinned = app.staticTexts["Pinned"].frame.minY
        let idle = ["Active two", "Idle three", "Idle four"].map(y), working = y("Working task")
        let aside = ["Parked alpha", "Parked beta"].map(y)
        // Rows are 48pt apart; a break adds 16.
        XCTAssertLessThan(pinned, y("Active one"), "the pinned task is not under its heading")
        XCTAssertGreaterThan(idle.min()! - y("Active one"), 56, "no break after Pinned")
        XCTAssertEqual(idle.max()! - idle.min()!, 96, accuracy: 1, "the idle run is not one run")
        XCTAssertGreaterThan(working - idle.max()!, 56, "no break before the working run")
        XCTAssertGreaterThan(aside.min()! - working, 56, "no break before the set-aside run")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "tasks-sheet"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
