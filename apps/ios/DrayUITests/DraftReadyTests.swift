import XCTest

/// #1207: a bot task whose PR is a draft carries Mark ready on its Waiting on
/// you row and in the sheet the row opens. Against a real server holding bot
/// `DRAY_BOT` and a task of its idle on a real draft PR for five minutes:
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=Scout
/// It marks that PR ready on GitHub.
final class DraftReadyTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testMarkDraftReady() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let bot = env["DRAY_BOT"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN and TEST_RUNNER_DRAY_BOT")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-bot.dismissedStalls", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        let botRow = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", bot)).firstMatch
        XCTAssertTrue(botRow.waitForExistence(timeout: 20), "no bot row")
        sleep(1)
        botRow.tap()

        XCTAssertTrue(app.staticTexts["Waiting on you"].waitForExistence(timeout: 30), "no Waiting on you card")
        let rowReady = app.buttons["Mark ready"].firstMatch
        XCTAssertTrue(rowReady.waitForExistence(timeout: 10), "the draft's row carries no Mark ready")
        sleep(2)
        snap(app, "1-row")

        // The row opens its sheet; Mark ready is the sheet's primary action there.
        // The card's row, not the chat's "Started a new task" line above it, which names the task too.
        let card = app.staticTexts["Waiting on you"].frame.maxY
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "README")).allElementsBoundByIndex
            .first { $0.frame.minY > card }
        XCTAssertNotNil(row, "no task row")
        row?.tap()
        XCTAssertTrue(app.buttons["Open task"].waitForExistence(timeout: 10), "no sheet")
        let sheetReady = app.navigationBars.buttons["Mark ready"]
        XCTAssertTrue(sheetReady.waitForExistence(timeout: 10), "the sheet carries no Mark ready")
        sleep(2)
        snap(app, "2-sheet")
        sheetReady.tap()

        // Out of draft, the PR is GitHub's to call ready, and Merge takes the slot.
        XCTAssertTrue(app.navigationBars.buttons["Merge"].waitForExistence(timeout: 60), "Merge never replaced Mark ready")
        XCTAssertFalse(app.buttons["Mark ready"].exists, "Mark ready stayed")
        sleep(2)
        snap(app, "3-ready")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
