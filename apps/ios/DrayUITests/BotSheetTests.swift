import XCTest

/// #1093 against a real server: New bot from the list, its chat's glass chip,
/// and the chip's sheet saying where it runs and saving a new name and colour.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… xcodebuild test -only-testing:DrayUITests/BotSheetTests
final class BotSheetTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testNewBotThenEdit() throws {
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

        let newBot = app.buttons["New bot"]
        XCTAssertTrue(newBot.waitForExistence(timeout: 20), "no New bot button")
        sleep(2)
        snap(app, "list")
        // Names must differ on a server, and runs against one leave their bots behind.
        let run = Int(Date().timeIntervalSince1970) % 100_000
        newBot.tap()
        let field = app.textFields["Bot name"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "no name field")
        field.tap()
        field.typeText("Scout \(run)")
        app.buttons["sun"].tap()
        app.buttons["Teal"].tap()
        snap(app, "new-bot")
        app.buttons["Create"].tap()

        let chip = app.buttons["botChip"]
        XCTAssertTrue(chip.waitForExistence(timeout: 60), "the new bot's chat did not open")
        sleep(8)
        snap(app, "bot-chat")
        chip.tap()
        XCTAssertTrue(app.staticTexts["Runs on"].waitForExistence(timeout: 5), "the chip opened no sheet")
        XCTAssertTrue(app.staticTexts["Test Mac"].exists, "the sheet does not say where the bot runs")
        snap(app, "edit-bot")
        let name = app.textFields["Bot name"]
        // At the field's far end, so the cursor lands after the centred name.
        name.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 20) + "Ranger \(run)")
        app.buttons["Pink"].tap()
        app.buttons["Save"].tap()
        XCTAssertTrue(app.buttons["Ranger \(run)"].waitForExistence(timeout: 10), "the rename did not reach the chip")
        sleep(1)
        snap(app, "renamed")

        // The sheet's agent pick moves the chat on the next message, as the desktop's does.
        chip.tap()
        let codex = app.buttons["Codex"]
        guard codex.waitForExistence(timeout: 5) else { return } // this machine has no Codex
        codex.tap()
        sleep(2)
        snap(app, "edit-agent")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Your next message moves this chat to Codex."].waitForExistence(timeout: 5),
                      "the dock does not say the chat moves")
        snap(app, "moving")
        app.buttons["Keyboard"].tap()
        let box = app.textViews.firstMatch
        XCTAssertTrue(box.waitForExistence(timeout: 5), "no reply sheet")
        box.typeText("Reply with just: hello from codex")
        app.buttons["Send"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Switched to Codex"].waitForExistence(timeout: 60), "the chat did not move to Codex")
        sleep(15)
        snap(app, "switched")
    }

    /// A bot (`DRAY_BOT`) whose chat runs longer than the screen: rows scroll under bare chips, no shade.
    func testHeaderOverScrolledChat() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let bot = env["DRAY_BOT"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN and TEST_RUNNER_DRAY_BOT")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", bot)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no bot row")
        row.tap()
        XCTAssertTrue(app.buttons["botChip"].waitForExistence(timeout: 10), "no bot chip")
        sleep(3)
        app.swipeDown()
        sleep(1)
        snap(app, "scrolled")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
