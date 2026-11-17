import XCTest

/// A Waiting on you row opens what the bot said about its task, in a sheet:
/// its reply to the task's last report, found by the server however far back it
/// sits in a long bot chat. A row with no reply opens the task itself. The card
/// holds five rows behind "Show N more".
/// Against a server seeded by `scripts/waiting_seed.py`:
///   TEST_RUNNER_DRAY_WAITING_URL=ws://127.0.0.1:47111 TEST_RUNNER_DRAY_TOKEN=1181…
final class WaitingOnYouTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testRowOpensBotReply() throws {
        let app = try pairedChat()
        let card = app.staticTexts["Waiting on you"]
        XCTAssertTrue(card.waitForExistence(timeout: 20), "no Waiting on you card")
        snap(app, "1-card")

        // Five of seven, the newest held back.
        XCTAssertFalse(row(app, "Dark mode contrast").exists, "more than five rows shown")
        let more = app.buttons["Show 2 more"]
        XCTAssertTrue(more.exists, "no Show 2 more")

        // The week-old task, its report hundreds of turns up the chat.
        row(app, "Fix login redirect").tap()
        XCTAssertTrue(text(app, "fixed the login loop").waitForExistence(timeout: 5), "the sheet drew no bot reply")
        XCTAssertFalse(text(app, "Should I open the PR?").exists, "the sheet drew the task's own message")
        XCTAssertTrue(app.buttons["Open image"].waitForExistence(timeout: 5), "the picture drew no button")
        snap(app, "2-sheet")
        // The button stands whether or not the read worked; the viewer labels a picture only once it loaded.
        app.buttons["Open image"].tap()
        let pager = app.descendants(matching: .any)["image-pager"]
        XCTAssertTrue(pager.waitForExistence(timeout: 5), "no viewer")
        XCTAssertTrue(pager.descendants(matching: .any)["Image"].waitForExistence(timeout: 10),
                      "the picture never loaded from the bot's server")
        app.buttons["Close"].tap()

        app.buttons["Open task"].tap()
        XCTAssertTrue(app.navigationBars.staticTexts["Fix login redirect"].waitForExistence(timeout: 5)
                      || app.staticTexts["Fix login redirect"].waitForExistence(timeout: 1), "Open task did not open it")
        XCTAssertFalse(app.buttons["Open task"].exists, "the sheet stayed up")
        snap(app, "3-task")
        back(app, card)

        // Reported, but the bot never answered: the row opens the task, no sheet.
        row(app, "Bump deps").tap()
        XCTAssertTrue(app.navigationBars.staticTexts["Bump deps"].waitForExistence(timeout: 5)
                      || app.staticTexts["Bump deps"].waitForExistence(timeout: 1), "a row with no reply did not open its task")
        XCTAssertFalse(app.buttons["Open task"].exists, "a row with no reply opened a sheet")
        snap(app, "4-no-reply-task")
        back(app, card)

        app.buttons["Show 2 more"].tap()
        XCTAssertTrue(row(app, "Dark mode contrast").waitForExistence(timeout: 3), "Show more drew no rows")
        XCTAssertTrue(app.buttons["Show less"].exists)
        snap(app, "5-all")
        row(app, "Dark mode contrast").tap()
        XCTAssertTrue(text(app, "which palette should lead").waitForExistence(timeout: 3), "the newest row's sheet drew no reply")
        snap(app, "6-newest-sheet")
        app.buttons["Done"].tap()
        app.buttons["Show less"].tap()
        XCTAssertTrue(app.buttons["Show 2 more"].waitForExistence(timeout: 3), "Show less did not cap the card")
    }

    private func back(_ app: XCUIApplication, _ card: XCUIElement) {
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(card.waitForExistence(timeout: 5), "Back did not return to the bot")
    }

    private func row(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    private func text(_ app: XCUIApplication, _ part: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", part)).firstMatch
    }

    /// Pairs the seeded server through a link and opens its bot's chat.
    private func pairedChat() throws -> XCUIApplication {
        guard let url = env["DRAY_WAITING_URL"], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-list.hideSessions", "NO", "-bot.dismissedStalls", ""]
        app.launch()
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        XCTAssertTrue(app.staticTexts["Ops"].waitForExistence(timeout: 15), "no bot row after pairing")
        // The list's cache is written two seconds after it settles; a lone bot opens itself from it (#1169).
        sleep(3)
        app.terminate()
        app.launchArguments = ["-list.hideSessions", "NO"]
        app.launch()
        XCTAssertTrue(app.buttons["Tasks"].waitForExistence(timeout: 15), "the bot's chat did not open")
        return app
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
