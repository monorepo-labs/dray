import XCTest

/// #1508 against a real `dray-serve` whose `gh` is signed in and which holds a
/// GitHub checkout: the pull requests and issues pages draw their last answer
/// at once after a relaunch, the PR list searches, and a PR's page shows its details.
///
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_SEARCH=<a word in one PR's title>
final class PullsCacheTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testPullsKeptAcrossLaunch() throws {
        var app = try pair()
        openPage(app, "Pull requests")
        app.buttons["All"].firstMatch.tap()
        XCTAssertTrue(app.buttons["pull.row"].firstMatch.waitForExistence(timeout: 60), "All drew no PR")
        sleep(3)
        app.buttons["Close"].tap()

        // Cold: the kept list draws before the server can have answered.
        app.terminate()
        app = XCUIApplication()
        app.launch()
        openPage(app, "Pull requests")
        XCTAssertTrue(app.buttons["pull.row"].firstMatch.waitForExistence(timeout: 2), "the list was not kept")
        snap(app, "01-pulls-cold-launch")
        sleep(4)
        snap(app, "01b-pulls-refreshed")
        // Several repositories, so each row names its own.
        app.buttons["Involving me"].firstMatch.tap()
        XCTAssertTrue(app.buttons["pull.row"].firstMatch.waitForExistence(timeout: 60), "Involving me drew no PR")
        sleep(4)
        snap(app, "01c-pulls-involving")
        app.buttons["All"].firstMatch.tap()
        sleep(2)

        // The search sits behind its button, and opens with the keyboard up.
        let word = env["DRAY_SEARCH"] ?? "iOS"
        app.buttons["Search"].tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 3), "no search field")
        sleep(1)
        field.typeText(word)
        sleep(1)
        snap(app, "02-pulls-search")
        let hit = app.buttons["pull.row"].firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 5), "search for \(word) found nothing")
        hit.tap()
        sleep(12)
        screen("03-pull-detail")
        for i in 0..<3 {
            app.swipeUp(velocity: .slow)
            sleep(2)
            screen("04-pull-detail-\(i)")
        }
    }

    func testIssuesKeptAcrossLaunch() throws {
        var app = try pair(["-issues.tracker", "github"])
        openPage(app, "Issues")
        let repo = app.buttons["issue.repo"].firstMatch
        if repo.waitForExistence(timeout: 30) { repo.tap() }
        app.buttons["All"].firstMatch.tap()
        XCTAssertTrue(app.buttons["issue.row"].firstMatch.waitForExistence(timeout: 60), "no issue rows")
        sleep(3)
        app.buttons["Close"].tap()

        app.terminate()
        app = XCUIApplication()
        app.launchArguments = ["-issues.tracker", "github"]
        app.launch()
        openPage(app, "Issues")
        XCTAssertTrue(app.buttons["issue.row"].firstMatch.waitForExistence(timeout: 2), "the issues were not kept")
        snap(app, "05-issues-cold-launch")
        sleep(4)
        app.buttons["Search"].tap()
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 3), "no search field")
        sleep(1)
        snap(app, "06-issues-search-open")
        app.buttons["Cancel"].tap()
        sleep(1)
        app.buttons["Filters"].tap()
        sleep(1)
        snap(app, "07-issues-filters")
    }

    func testNoAppearancePage() throws {
        let app = try pair()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 20))
        app.buttons["Settings"].tap()
        sleep(2)
        XCTAssertFalse(app.staticTexts["Appearance"].exists, "Appearance is still in Settings")
        snap(app, "08-settings")
    }

    private func openPage(_ app: XCUIApplication, _ name: String) {
        let button = app.buttons[name]
        XCTAssertTrue(button.waitForExistence(timeout: 30), "no \(name) button")
        button.tap()
    }

    private func pair(_ arguments: [String] = []) throws -> XCUIApplication {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""] + arguments
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "This Mac")]
        app.open(link.url!)
        // A fresh simulator asks before a link opens the app.
        let open = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
        if open.waitForExistence(timeout: 5) { open.tap() }
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

    /// The page's spinners keep the app from idling, so detail shots go through the screen.
    private func screen(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
