import XCTest

/// A merge card's Merge lands the PR, and the server settles its task and removes
/// its worktree, whether the task runs on the chat's server or on another
/// machine the phone never connects to. Against a real server whose bot chat
/// holds two open cards, one per task:
///   TEST_RUNNER_DRAY_MERGE_URL=ws://127.0.0.1:47231 TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_MERGE_NUMBERS=1,2
/// What it settles is checked on the servers afterwards (`dray session ls --all`).
final class MergeSettleTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testMergeCardsLand() throws {
        guard let url = env["DRAY_MERGE_URL"], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
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
        let bot = app.staticTexts["Settle Bot"].firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 15), "no bot row after pairing")
        if !app.buttons["Tasks"].exists { bot.tap() }
        XCTAssertTrue(app.buttons["Tasks"].waitForExistence(timeout: 15), "the bot's chat did not open")

        let numbers = (env["DRAY_MERGE_NUMBERS"] ?? "1,2").split(separator: ",").map(String.init)
        for number in numbers {
            let merge = app.buttons["Merge"].firstMatch
            XCTAssertTrue(merge.waitForExistence(timeout: 30), "no Merge on card #\(number)")
            snap(app, "\(number)-before")
            merge.tap()
            let squash = app.buttons["Squash and merge"]
            XCTAssertTrue(squash.waitForExistence(timeout: 5), "no merge methods")
            squash.tap()
            let merged = app.descendants(matching: .any)["Merged #\(number)"]
            XCTAssertTrue(merged.waitForExistence(timeout: 90), "card #\(number) never read merged")
            snap(app, "\(number)-merged")
        }
        // Long enough for the server's settle to land before the run ends.
        sleep(10)
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
