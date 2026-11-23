import XCTest

/// #1439 against real servers and real agents: a task's This task sheet moves it to another
/// agent at the next send, a bot chat's too, a move made elsewhere moves the picker, a turn
/// running refuses the switch, and a server from before `switch_agent` sends nothing.
///   TEST_RUNNER_DRAY_URL=ws://… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_OLD_URL=ws://… TEST_RUNNER_DRAY_OLD_TOKEN=…
///   TEST_RUNNER_DRAY_SIGNAL_DIR=/private/tmp/… xcodebuild test -only-testing:DrayUITests/AgentSwitchTests
/// The server holds a task "Switch test" on Claude Code and a bot "Otter"; the old one a task "Old server task".
/// The signal files are for a host script: `move` runs `dray session model <id> haiku`, `busy` starts a long turn.
final class AgentSwitchTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func test1TaskSwitch() throws {
        let app = try open("Switch test")
        pickCodex(app)
        snap(app, "task-sheet")
        dismissSheet(app)
        XCTAssertTrue(app.staticTexts["Your next message goes to Codex"].waitForExistence(timeout: 5))
        snap(app, "task-takes-over")
        app.reply("What word did I ask you to remember? Reply with it reversed, in lowercase, and nothing else.")
        XCTAssertTrue(waitForText(app, "nacilep", timeout: 180), "Codex never answered from the replayed conversation")
        XCTAssertFalse(app.staticTexts["Your next message goes to Codex"].exists, "the line outlived the send")
        XCTAssertFalse(hasText(app, "Switched to"), "a switch line was drawn")
        sleep(2)
        snap(app, "task-after")
    }

    func test2FollowsMoveElsewhere() throws {
        let app = try open("Switch test")
        signal("move")
        sleep(8)
        app.buttons["Model"].tap()
        let claude = app.buttons["Claude Code"]
        XCTAssertTrue(claude.waitForExistence(timeout: 10))
        XCTAssertTrue(claude.isSelected, "the picker did not follow the move to Claude Code")
        XCTAssertFalse(app.buttons["Codex"].isSelected)
        snap(app, "followed-move")
    }

    func test3MidTurnRefused() throws {
        let app = try open("Switch test")
        pickCodex(app)
        dismissSheet(app)
        signal("busy")
        XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 90), "no turn started")
        app.reply("This must not send.")
        XCTAssertTrue(waitForText(app, "Wait for this turn to finish before switching to Codex.", timeout: 15))
        snap(app, "mid-turn-refused")
    }

    func test4BotSwitch() throws {
        let app = try open("Otter")
        pickCodex(app)
        dismissSheet(app)
        XCTAssertTrue(app.staticTexts["Your next message goes to Codex"].waitForExistence(timeout: 5))
        snap(app, "bot-takes-over")
        app.reply("Reply with the word BANJO reversed, in lowercase, and nothing else.")
        XCTAssertTrue(waitForText(app, "ojnab", timeout: 180), "Codex never answered in the bot chat")
        XCTAssertFalse(hasText(app, "Switched to"), "a switch line was drawn")
        sleep(2)
        snap(app, "bot-after")
    }

    func test5OldServer() throws {
        guard let url = env["DRAY_OLD_URL"], let token = env["DRAY_OLD_TOKEN"] else { throw XCTSkip("no old server") }
        let app = try open("Old server task", url: url, token: token)
        pickCodex(app, luna: false)
        dismissSheet(app)
        app.reply("This must not send either.")
        XCTAssertTrue(waitForText(app, "Update this server to switch a task to Codex.", timeout: 15))
        snap(app, "old-server")
    }

    // MARK: Helpers

    private func open(_ row: String, url: String? = nil, token: String? = nil) throws -> XCUIApplication {
        guard let url = url ?? env["DRAY_URL"], let token = token ?? env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        let app = XCUIApplication()
        // 6 Luna is off Codex's shortlist by default.
        app.launchArguments = ["-servers", "", "-shortlist.codex", "(\"gpt-6-luna\")"]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        let item = app.staticTexts[row].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 20), "no row \(row)")
        item.tap()
        XCTAssertTrue(app.dock.waitForExistence(timeout: 15))
        sleep(2)
        return app
    }

    /// This task → Codex, then 6 Luna at Low.
    private func pickCodex(_ app: XCUIApplication, luna: Bool = true) {
        app.buttons["Model"].tap()
        let codex = app.buttons["Codex"]
        XCTAssertTrue(codex.waitForExistence(timeout: 10), "This task offers no agents")
        codex.tap()
        guard luna else { return }
        let model = app.buttons["6 Luna"]
        XCTAssertTrue(model.waitForExistence(timeout: 10), "Codex's models never came")
        model.tap()
        app.buttons["row.Effort"].tap()
        let low = app.buttons["Low"]
        XCTAssertTrue(low.waitForExistence(timeout: 5))
        low.tap()
        sleep(1)
    }

    private func dismissSheet(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        sleep(1)
    }

    private func signal(_ name: String) {
        guard let dir = env["DRAY_SIGNAL_DIR"] else { return }
        FileManager.default.createFile(atPath: "\(dir)/\(name)", contents: nil)
    }

    private func hasText(_ app: XCUIApplication, _ text: String) -> Bool {
        app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch.exists
            || app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch.exists
    }

    private func waitForText(_ app: XCUIApplication, _ text: String, timeout: TimeInterval) -> Bool {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch.waitForExistence(timeout: timeout)
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
