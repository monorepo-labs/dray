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
        let app = try connect()
        try open(app, env["DRAY_TASK"]!)
        let pages = max(1, Int(env["DRAY_PAGES"] ?? "") ?? 3)
        for page in 1...pages {
            guard let line = try tapEarlier(app, "task page \(page)") else { break }
            check(app, line, "task page \(page)")
        }

        guard let bot = env["DRAY_BOT"] else { return }
        app.navigationBars.buttons.element(boundBy: 0).tap()
        try open(app, bot)
        for page in 1...pages {
            guard let line = try tapEarlier(app, "bot page \(page)") else { break }
            check(app, line, "bot page \(page)")
        }
    }

    private func connect() throws -> XCUIApplication {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], env["DRAY_TASK"] != nil else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN and TEST_RUNNER_DRAY_TASK")
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

    private func open(_ app: XCUIApplication, _ title: String) throws {
        // An iPad in portrait opens on a new task with the list folded away.
        let sidebar = app.buttons["Show Sidebar"]
        if sidebar.waitForExistence(timeout: 3) { sidebar.tap() }
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no row \(title)")
        row.tap()
        XCTAssertTrue(app.buttons["Load earlier"].waitForExistence(timeout: 30), "no Load earlier in \(title)")
        sleep(2)
    }

    /// Scrolls up to "Load earlier", notes the first line under it and taps it, waiting for the
    /// page. Nil once the chat is read to its start.
    private func tapEarlier(_ app: XCUIApplication, _ what: String) throws -> (label: String, y: CGFloat)? {
        let earlier = app.buttons["Load earlier"]
        for _ in 0..<30 where earlier.exists && !earlier.isHittable { app.swipeDown(velocity: .fast) }
        guard earlier.exists else { return nil }
        XCTAssertTrue(earlier.isHittable, "\(what): Load earlier out of reach")
        sleep(2)
        let below = earlier.frame.maxY
        // One snapshot, not a query per text: a long chat holds hundreds. Past 20 characters skips
        // the bot chat's time label, which heads its first row and goes once a page lands above.
        let line = texts(try app.snapshot())
            .filter { $0.frame.minY > below && $0.frame.maxY < app.frame.maxY - 150 && $0.label.count > 20 }
            .min { $0.frame.minY < $1.frame.minY }
        guard let line else { XCTFail("\(what): nothing under Load earlier"); return nil }
        earlier.tap()
        let loading = app.descendants(matching: .any)["loadingEarlier"]
        wait(for: [expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: loading)], timeout: 30)
        sleep(2)
        return (line.label, line.frame.minY)
    }

    /// The line sits where it did, judged by the copy of its text nearest that spot.
    private func check(_ app: XCUIApplication, _ line: (label: String, y: CGFloat), _ what: String) {
        let ys = ((try? app.snapshot()).map(texts) ?? []).filter { $0.label == line.label }.map(\.frame.minY)
        guard let y = ys.min(by: { abs($0 - line.y) < abs($1 - line.y) }) else {
            return XCTFail("\(what): \"\(line.label.prefix(40))\" is gone")
        }
        XCTAssertEqual(y, line.y, accuracy: 2, "\(what): \"\(line.label.prefix(40))\" moved")
        snap(app, what)
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
