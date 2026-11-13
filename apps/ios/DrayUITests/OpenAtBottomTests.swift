import XCTest

/// A chat opens on its newest rows, in view, never scrolled past them onto
/// blank; and a bot's Tasks sheet lists its tasks on shared machines too.
/// Against a real server holding a bot (`DRAY_BOT`) with a task started on a
/// machine that server shares:
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=Dray xcodebuild test …
final class OpenAtBottomTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testChatsOpenAtTheBottom() throws {
        guard let name = env["DRAY_BOT"] else { throw XCTSkip("set TEST_RUNNER_DRAY_BOT") }
        let app = try connected()
        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 20), "no bot row")
        // The shared machines connect after the paired server does.
        sleep(15)
        snap(app, "list")

        bot.tap()
        assertRowsInView(app, "bot chat")
        snap(app, "bot-chat")

        app.buttons["Tasks"].tap()
        sleep(2)
        snap(app, "bot-tasks")
        let rows = app.buttons.matching(identifier: "botTask")
        let count = min(rows.count, 6)
        XCTAssertGreaterThan(count, 0, "the Tasks sheet is empty")
        app.buttons["Done"].tap()

        // Each task opened over the chat, and back: one drawing blank fails.
        for i in 0..<count {
            app.buttons["Tasks"].tap()
            sleep(1)
            let row = rows.element(boundBy: i)
            guard row.waitForExistence(timeout: 5) else { break }
            let title = row.label
            row.tap()
            assertRowsInView(app, "task \(i) \(title)")
            snap(app, "task-\(i)")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            XCTAssertTrue(app.buttons["Tasks"].waitForExistence(timeout: 5))
            assertRowsInView(app, "bot chat after task \(i)")
        }
    }

    /// What the cache draws, replaced by a read that holds less: run `testHeldShrinks1`, append
    /// short turns to the session's log on the server, then `testHeldShrinks2`. Wants a scratch
    /// server holding one session titled "Scroll check" of tall turns.
    func testHeldShrinks1() throws {
        let app = try connected()
        let row = app.staticTexts["Scroll check"]
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no session")
        row.tap()
        assertRowsInView(app, "first open")
        snap(app, "first-open")
    }

    func testHeldShrinks2() throws {
        guard env["DRAY_URL"] != nil else { throw XCTSkip("run after testHeldShrinks1, with TEST_RUNNER_DRAY_URL set") }
        let app = XCUIApplication()
        app.launch()
        let row = app.staticTexts["Scroll check"]
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no session")
        row.tap()
        assertRowsInView(app, "reopened")
        snap(app, "reopened")
    }

    /// A running turn follows while the reader is at the end, and leaves them be once they scroll
    /// up; back at the end it follows again. Wants the newest session mid-turn, adding rows.
    func testFollowsOnlyAtTheBottom() throws {
        let app = try connected()
        guard let title = env["DRAY_SESSION"] else { throw XCTSkip("set TEST_RUNNER_DRAY_SESSION to the running session's title") }
        let row = app.staticTexts.matching(identifier: title).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no session")
        row.tap()
        sleep(12)
        snap(app, "1-following")
        let atEnd = visible(app)

        let scroll = app.scrollViews.firstMatch
        scroll.swipeDown(velocity: .slow)
        sleep(2)
        let read = visible(app)
        XCTAssertNotEqual(read, atEnd, "the swipe did not move the view")
        let place = top(app, read.first ?? "")
        snap(app, "2-scrolled-up")
        sleep(15)
        XCTAssertEqual(top(app, read.first ?? ""), place, accuracy: 4, "new rows moved the reader off their place")
        snap(app, "3-still-in-place")

        for _ in 0..<3 { scroll.swipeUp(velocity: .fast) }
        sleep(2)
        let back = visible(app)
        sleep(15)
        XCTAssertNotEqual(visible(app), back, "back at the end, new rows did not follow")
        snap(app, "4-following-again")
    }

    /// Where a text sits on screen, by its label.
    private func top(_ app: XCUIApplication, _ label: String) -> CGFloat {
        guard let tree = try? app.scrollViews.firstMatch.snapshot() else { return .nan }
        func find(_ n: XCUIElementSnapshot) -> XCUIElementSnapshot? {
            n.elementType == .staticText && n.label == label ? n : n.children.lazy.compactMap(find).first
        }
        return find(tree)?.frame.minY ?? .nan
    }

    /// The labels of the texts on screen in the transcript, top to bottom.
    private func visible(_ app: XCUIApplication) -> [String] {
        guard let tree = try? app.scrollViews.firstMatch.snapshot() else { return [] }
        let frame = tree.frame.insetBy(dx: 0, dy: 120)
        func texts(_ n: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
            (n.elementType == .staticText ? [n] : []) + n.children.flatMap(texts)
        }
        return texts(tree).filter { !$0.label.isEmpty && frame.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) }
            .sorted { $0.frame.minY < $1.frame.minY }.map(\.label)
    }

    /// A bot's working line names its running tool on one line, however long the
    /// command. Wants the bot `DRAY_BOT` mid-way through a long Bash call.
    func testRunningToolIsOneLine() throws {
        guard let name = env["DRAY_BOT"] else { throw XCTSkip("set TEST_RUNNER_DRAY_BOT") }
        let app = try connected()
        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 20), "no bot row")
        bot.tap()
        let line = app.descendants(matching: .any)
            .matching(NSPredicate(format: "(label BEGINSWITH 'Running' OR label BEGINSWITH 'Bash') AND label CONTAINS 'deliberately'")).firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 30), "no running tool line")
        sleep(1)
        snap(app, "running-tool")
        XCTAssertLessThan(line.frame.height, 30, "the running tool's line wraps")
    }

    /// Text inside the transcript's visible frame, a beat after opening and again once the read lands.
    private func assertRowsInView(_ app: XCUIApplication, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        for wait in [1, 4] {
            sleep(UInt32(wait))
            let scroll = app.scrollViews.firstMatch
            guard scroll.waitForExistence(timeout: 5) else { return XCTFail("\(what): no transcript", file: file, line: line) }
            // One snapshot, not a query per text: every row is drawn, so there are hundreds.
            guard let tree = try? scroll.snapshot() else { return XCTFail("\(what): no snapshot", file: file, line: line) }
            let frame = tree.frame
            func texts(_ n: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
                (n.elementType == .staticText ? [n] : []) + n.children.flatMap(texts)
            }
            let seen = texts(tree).contains { t in
                !t.label.isEmpty && frame.intersects(t.frame) && t.frame.minY < frame.maxY - 140
            }
            if !seen { snap(app, "blank-\(what)") }
            XCTAssertTrue(seen, "\(what): nothing in view after \(wait)s", file: file, line: line)
        }
    }

    private func connected() throws -> XCUIApplication {
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
