import XCTest

/// A merge card names the job its task left running, and drops it once that
/// work ends. Against a real server whose bot chat holds a card for a task with
/// a background command running; the runner ends the command while this waits:
///   TEST_RUNNER_DRAY_CARD_URL=ws://127.0.0.1:47231 TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_CARD_BOT=…
final class MergeCardWorkTests: XCTestCase {
    func testRunningLineFollowsTheTask() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_CARD_URL"], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-list.hideSessions", "NO", "-bot.dismissedStalls", ""]
        app.launch()
        XCTAssertTrue(app.buttons["Enter an address"].waitForExistence(timeout: 10), "no empty list")
        app.buttons["Enter an address"].tap()
        for (field, text) in [("Address", url), ("Token", token), ("Name", "Test Mac")] {
            XCTAssertTrue(app.textFields[field].waitForExistence(timeout: 5), "no \(field) field")
            app.textFields[field].tap()
            app.textFields[field].typeText(text)
        }
        app.buttons["Add"].tap()
        let bot = app.staticTexts[env["DRAY_CARD_BOT"] ?? "Card Bot"].firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 15), "no bot row after pairing")
        if !app.buttons["Tasks"].exists { bot.tap() }
        XCTAssertTrue(app.buttons["Tasks"].waitForExistence(timeout: 15), "the bot's chat did not open")

        let line = app.descendants(matching: .any)["mergeCardRunning"].firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 30), "no running line on the card")
        let job = env["DRAY_CARD_JOB"] ?? "Wait for the CI build"
        XCTAssertTrue(line.label.contains(job), "line reads \(line.label)")
        // The runner ends the task's command meanwhile; the line goes with it.
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: line)
        wait(for: [gone], timeout: 240)
        sleep(3)
    }
}
