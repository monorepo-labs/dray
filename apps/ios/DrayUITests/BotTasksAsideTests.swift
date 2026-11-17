import XCTest

/// A bot's Tasks sheet sinks set-aside tasks under the rest, as the desktop's Tasks tab does.
/// Needs a live server holding a bot named "Aside Bot" whose tasks "Active one" and "Active two"
/// are idle and "Parked alpha" and "Parked beta" are set aside:
///   TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_ASIDE_URL=ws://127.0.0.1:47231
final class BotTasksAsideTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testAsideTasksSinkLast() throws {
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

        let y = { (title: String) in app.buttons.matching(identifier: "botTask").containing(.staticText, identifier: title).firstMatch.frame.minY }
        let active = ["Active one", "Active two"].map(y), aside = ["Parked alpha", "Parked beta"].map(y)
        XCTAssertLessThan(active.max()!, aside.min()!, "a set-aside task sits among the active ones")
        // Rows are 48pt apart; the break before the set-aside run adds to that.
        XCTAssertGreaterThan(aside.min()! - active.max()!, 56, "no break before the set-aside run")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "tasks-sheet"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
