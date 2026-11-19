import XCTest

/// #1207: a task whose PR is a draft carries the draft glyph top right, and its
/// sheet marks the PR ready. Against a real server holding bot `DRAY_BOT` and a
/// task of its on a real draft PR with no checks (a running check swaps the
/// Tasks row's glyph for a spinner):
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=Scout
/// It marks that PR ready on GitHub.
final class DraftReadyTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testMarkDraftReady() throws {
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
        let botRow = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", bot)).firstMatch
        XCTAssertTrue(botRow.waitForExistence(timeout: 20), "no bot row")
        sleep(1)
        botRow.tap()

        // The bot's Tasks sheet lists the task with its draft glyph, and a tap opens it.
        let tasks = app.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 20), "no Tasks button")
        sleep(1)
        tasks.tap()
        // The row holding the draft glyph: a task asking or ready to merge sorts above it.
        let row = app.buttons.matching(identifier: "botTask").containing(state("draft")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no task row with a draft glyph")
        sleep(2)
        snap(app, "0-tasks")
        row.tap()

        let button = app.buttons["Pull request"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "no PR button on the task")
        sleep(2)
        snap(app, "1-task")
        button.tap()

        let ready = app.buttons["Ready for review"]
        XCTAssertTrue(ready.waitForExistence(timeout: 10), "the sheet carries no Ready for review")
        sleep(2)
        snap(app, "2-sheet")
        ready.tap()

        // Out of draft, the sheet's action is Merge's.
        XCTAssertTrue(app.staticTexts["Ready to merge"].waitForExistence(timeout: 60)
                      || app.staticTexts["Checking mergeability…"].exists, "the PR never left draft")
        sleep(2)
        snap(app, "3-ready")
        app.buttons["Done"].tap()
        sleep(3)
        snap(app, "4-open")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(tasks.waitForExistence(timeout: 10), "Back did not return to the bot")
        tasks.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(state("open")).firstMatch.waitForExistence(timeout: 5),
                      "the row still reads draft")
        sleep(2)
        snap(app, "5-tasks-open")
    }

    /// `PrGlyph`'s label in a given state, whatever the PR's number or a ", checks failing" after it.
    private func state(_ state: String) -> NSPredicate {
        NSPredicate(format: "label BEGINSWITH 'Pull request #' AND label CONTAINS %@", ", \(state)")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
