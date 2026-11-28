import XCTest

/// A bot's `dray session send --machine <name> <id> "…"` draws a "Messaged" row naming the task,
/// and the row opens that task, which lives on the other machine's server (#1643). Against a live
/// server sharing that machine (`dray machine share on`), with a bot that has run such a send:
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=<bot name>
///   TEST_RUNNER_DRAY_TASK=<task title> TEST_RUNNER_DRAY_PROMPT=<the task's first prompt> xcodebuild test …
final class MachineSendTests: XCTestCase {
    func testSendToAnotherMachineDrawsAndOpensTheTask() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let bot = env["DRAY_BOT"],
              let task = env["DRAY_TASK"], let prompt = env["DRAY_PROMPT"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, _TOKEN, _BOT, _TASK and _PROMPT")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()

        let row = app.staticTexts[bot].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no row for \(bot)")
        row.tap()
        XCTAssertTrue(app.staticTexts["Messaged"].firstMatch.waitForExistence(timeout: 30), "no Messaged row")
        // The chip names the task only once the other machine's index is in.
        let chip = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", task)).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 30), "the Messaged row does not name \(task)")
        snap(app, "1-messaged")

        chip.tap()
        XCTAssertTrue(app.staticTexts[prompt].firstMatch.waitForExistence(timeout: 30), "the row did not open \(task)")
        sleep(2)
        snap(app, "2-task")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
