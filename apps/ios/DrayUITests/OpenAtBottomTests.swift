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

    /// The newest row sits whole just above the dock on every open: cold, then again from
    /// memory, checked once more after the chat's pictures and videos have loaded. Wants
    /// `DRAY_CHATS`, the list rows to open, "|" between them: a session's title, or the start of
    /// a bot row's label. Long ones with media, behind `scripts/late_turns_proxy.py`.
    func testNewestRowClearsTheDock() throws {
        let app = try connected()
        for round in 1...(Int(env["DRAY_ROUNDS"] ?? "") ?? 3) {
            for chat in try chats() {
                open(app, chat)
                assertAtEnd(app, "\(chat), open \(round)")
                back(app)
            }
        }
    }

    /// The same when a turn lands with the chat open, and when one lands with the reader back
    /// on the list. Wants `DRAY_LATE`, the proxy's `/late` URL.
    func testNewestRowClearsTheDockAfterATurnLands() throws {
        guard let late = env["DRAY_LATE"] else { throw XCTSkip("set TEST_RUNNER_DRAY_LATE") }
        let app = try connected()
        for chat in try chats() {
            open(app, chat)
            assertAtEnd(app, "\(chat), opened")
            try land(app, late, "\(chat), a turn landing in it")
            back(app)
            let tag = try land(late)
            // The reconnect and its read, with nothing on screen to wait on.
            sleep(8)
            open(app, chat)
            XCTAssertTrue(app.staticTexts["Last line of \(tag)."].waitForExistence(timeout: 20), "\(chat): the turn never landed")
            assertAtEnd(app, "\(chat), a turn landed while away")
            back(app)
        }
    }

    /// The same from the cache a relaunch reads, under a read bringing a turn the cache never
    /// held: run `testNewestRowClearsTheDock`, fetch the proxy's `/late`, then this.
    func testNewestRowClearsTheDockReopened() throws {
        guard env["DRAY_URL"] != nil else { throw XCTSkip("run after testNewestRowClearsTheDock, with TEST_RUNNER_DRAY_URL set") }
        let app = XCUIApplication()
        app.launch()
        for chat in try chats() {
            open(app, chat)
            assertAtEnd(app, "\(chat), reopened")
            back(app)
        }
    }

    private func chats() throws -> [String] {
        guard let chats = env["DRAY_CHATS"]?.split(separator: "|").map(String.init), !chats.isEmpty else {
            throw XCTSkip("set TEST_RUNNER_DRAY_CHATS")
        }
        return chats
    }

    private func open(_ app: XCUIApplication, _ chat: String) {
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", chat)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no row for \(chat)")
        row.tap()
        XCTAssertTrue(app.dock.waitForExistence(timeout: 10), "\(chat) did not open")
    }

    private func back(_ app: XCUIApplication) {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    /// Has the proxy add a turn to every chat and drop the socket; answers the turn's tag.
    private func land(_ late: String) throws -> String {
        let tag = String(UUID().uuidString.prefix(6))
        _ = try Data(contentsOf: XCTUnwrap(URL(string: "\(late)?tag=\(tag)")))
        return tag
    }

    /// A turn landing in the open chat: its last line drawn, and the view at the end again.
    private func land(_ app: XCUIApplication, _ late: String, _ what: String) throws {
        let tag = try land(late)
        XCTAssertTrue(app.staticTexts["Last line of \(tag)."].waitForExistence(timeout: 20), "\(what): it never landed")
        assertAtEnd(app, what)
    }

    /// A beat in, once the read has landed, and once late media has: the lowest thing the
    /// transcript draws sits just above the dock each time, neither under it nor far up.
    private func assertAtEnd(_ app: XCUIApplication, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        for wait in [1, 3, 6] {
            sleep(UInt32(wait))
            let gap = gapAboveOrb(app)
            print("GAP \(what) +\(wait)s: \(gap)")
            snap(app, "\(what) +\(wait)s \(gap.rounded())")
            XCTAssertGreaterThanOrEqual(gap, 74, "\(what), +\(wait)s: the newest row is behind the dock", file: file, line: line)
            XCTAssertLessThanOrEqual(gap, 160, "\(what), +\(wait)s: the chat is not at its end", file: file, line: line)
        }
    }

    /// From the lowest thing the transcript draws down to the orb's top. At the end that is the
    /// stack's last spacing and padding, the dock's fade and the home indicator's inset, 114pt
    /// and a bot chat's 28 more; under 74 is a row behind the dock.
    private func gapAboveOrb(_ app: XCUIApplication) -> CGFloat {
        // A long chat mid-layout can time a snapshot out; the next one answers.
        guard let tree = (0..<3).lazy.compactMap({ _ in try? app.scrollViews.firstMatch.snapshot() }).first else { return .nan }
        // Leaves alone, a video's controls among them, and none as thin as a scroll indicator.
        func drawn(_ n: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
            n.children.isEmpty ? (n.frame.width < 10 ? [] : [n]) : n.children.flatMap(drawn)
        }
        let lowest = drawn(tree).map(\.frame.maxY).max() ?? .nan
        return app.buttons["orb"].frame.minY - lowest
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

    /// A turn landing leaves a reader who scrolled up where they are; once they are back at the
    /// end, the next one is followed again. Wants `DRAY_LATE`, and opens the first of `DRAY_CHATS`.
    func testFollowsOnlyAtTheBottom() throws {
        guard let late = env["DRAY_LATE"] else { throw XCTSkip("set TEST_RUNNER_DRAY_LATE") }
        let app = try connected()
        let chat = try chats()[0]
        open(app, chat)
        assertAtEnd(app, "\(chat), opened")

        let scroll = app.scrollViews.firstMatch
        scroll.swipeDown(velocity: .slow)
        sleep(2)
        snap(app, "scrolled up")
        let tag = try land(late)
        XCTAssertTrue(app.staticTexts["Last line of \(tag)."].waitForExistence(timeout: 20), "the turn never landed")
        // Its media too. Not where a row sits: a picture loading above the reader moves that.
        sleep(8)
        snap(app, "left alone")
        XCTAssertLessThan(gapAboveOrb(app), 0, "a turn landing pulled the reader to the end")

        for _ in 0..<40 where gapAboveOrb(app) < 74 { scroll.swipeUp(velocity: .fast) }
        sleep(2)
        try land(app, late, "\(chat), back at the end")
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
