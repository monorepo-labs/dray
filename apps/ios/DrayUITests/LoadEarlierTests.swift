import XCTest

/// "Load earlier" puts the page it reads above, out of sight, and leaves what the reader was
/// looking at where it was on screen, in a task and in a bot chat alike (#1422).
/// Against a real server holding a task and a bot chat each several pages long:
///   TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN,
///   TEST_RUNNER_DRAY_TASK (the task's title), TEST_RUNNER_DRAY_BOT (optional: a bot's name),
///   TEST_RUNNER_DRAY_PAGES (optional: taps per chat, 3 by default)
final class LoadEarlierTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testLoadEarlierHoldsThePlace() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let task = env["DRAY_TASK"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN and TEST_RUNNER_DRAY_TASK")
        }
        let pages = Int(env["DRAY_PAGES"] ?? "") ?? 3
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()

        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", task)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no task row")
        row.tap()
        try holds(app, pages, "task")

        guard let bot = env["DRAY_BOT"] else { return }
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let botRow = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", bot)).firstMatch
        XCTAssertTrue(botRow.waitForExistence(timeout: 10), "no bot row")
        botRow.tap()
        try holds(app, pages, "bot")
    }

    /// Scrolls up to "Load earlier" and taps it `pages` times, each time checking the first
    /// line under the button sits where it sat before the page landed.
    private func holds(_ app: XCUIApplication, _ pages: Int, _ chat: String) throws {
        let earlier = app.buttons["Load earlier"]
        XCTAssertTrue(earlier.waitForExistence(timeout: 30), "no Load earlier in the \(chat)")
        sleep(2)
        for page in 1...pages {
            for _ in 0..<30 where !earlier.isHittable { app.swipeDown(velocity: .fast) }
            XCTAssertTrue(earlier.isHittable, "Load earlier out of reach in the \(chat)")
            sleep(2)
            let below = earlier.frame.maxY
            // One snapshot, not a query per text: a long chat holds hundreds. Past 20 characters skips
            // the bot chat's time label, which heads its first row and goes once a page lands above.
            let line = texts(try app.snapshot())
                .filter { $0.frame.minY > below && $0.frame.maxY < app.frame.maxY - 150 && $0.label.count > 20 }
                .min { $0.frame.minY < $1.frame.minY }
            guard let line else { return XCTFail("nothing under Load earlier in the \(chat)") }
            let label = line.label, y = line.frame.minY
            earlier.tap()
            let loading = app.descendants(matching: .any)["loadingEarlier"]
            let done = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: loading)
            wait(for: [done], timeout: 30)
            sleep(2)
            let after = app.staticTexts.matching(NSPredicate(format: "label == %@", label)).firstMatch
            XCTAssertTrue(after.exists, "\(chat) page \(page): \"\(label.prefix(40))\" is gone")
            XCTAssertEqual(after.frame.minY, y, accuracy: 2, "\(chat) page \(page): \"\(label.prefix(40))\" moved")
            snap(app, "\(chat)-page-\(page)")
        }
    }

    private func texts(_ s: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
        (s.elementType == .staticText ? [s] : []) + s.children.flatMap(texts)
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
