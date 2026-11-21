import XCTest

/// The pull requests and issues pages against a real `dray-serve` whose `gh`
/// is signed in, so the rows are GitHub's own:
///
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… xcodebuild test -only-testing:DrayUITests/PullsIssuesTests
///
/// `testStartTask` starts a real task on the first PR of `TEST_RUNNER_DRAY_START_REPO`
/// (a checkout under `/private/tmp`), told to answer and touch nothing.
final class PullsIssuesTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testPulls() throws {
        let app = try pair()
        openPage(app, "Pull requests")
        // The filter is kept on the phone, so an earlier run may have left another.
        app.buttons["Involving me"].firstMatch.tap()
        let row = app.buttons["pull.row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 60), "Involving me drew no PR")
        sleep(2)
        snap(app, "01-pulls-involving")
        for filter in ["Mine", "Review requested", "All"] {
            app.buttons[filter].firstMatch.tap()
            sleep(6)
            snap(app, "02-pulls-\(filter)")
        }
        app.buttons["Involving me"].firstMatch.tap()
        sleep(2)
        app.buttons["Filters"].tap()
        sleep(1)
        snap(app, "03-pulls-filters")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Owner")).firstMatch.tap()
        sleep(1)
        snap(app, "03b-pulls-owner")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.97)).tap()
        sleep(1)
        // A PR with checks and comments, by title where one is named.
        let title = env["DRAY_PR_TITLE"] ?? ""
        let pr = title.isEmpty ? row : app.buttons.matching(identifier: "pull.row").matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(pr.waitForExistence(timeout: 30), "no PR titled \(title)")
        pr.tap()
        // Screen shots only from here: the page's spinners keep the app from idling, and queries crawl.
        sleep(15)
        screen("04-pull-detail")
        for (i, swipes) in [2, 2, 3, 3].enumerated() {
            for _ in 0..<swipes { app.swipeUp(velocity: .slow) }
            sleep(2)
            screen("05-pull-detail-\(i)")
        }
    }

    private func screen(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testIssues() throws {
        let app = try pair()
        openPage(app, "Issues")
        app.buttons["GitHub"].firstMatch.tap()
        sleep(3)
        // A server that met `gh` failing keeps that answer until asked again.
        let recheck = app.buttons["Check again"]
        if recheck.exists { recheck.tap(); sleep(5) }
        let repo = app.buttons["issue.repo"].firstMatch
        if repo.waitForExistence(timeout: 20) {
            snap(app, "10-issues-pick-repo")
            repo.tap()
        }
        app.buttons["All"].firstMatch.tap()
        let row = app.buttons["issue.row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 60), "GitHub drew no issue")
        sleep(2)
        snap(app, "11-issues-github")
        row.tap()
        XCTAssertTrue(app.buttons["Work on it"].waitForExistence(timeout: 30))
        sleep(3)
        snap(app, "12-issue-github")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        sleep(1)
        app.buttons["Linear"].firstMatch.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 60), "Linear drew no issue")
        sleep(2)
        snap(app, "13-issues-linear")
        row.tap()
        XCTAssertTrue(app.buttons["Work on it"].waitForExistence(timeout: 30))
        sleep(3)
        snap(app, "14-issue-linear")
        app.buttons["Work on it"].tap()
        sleep(2)
        snap(app, "15-work-on-it")
    }

    func testStartTask() throws {
        guard let repo = env["DRAY_START_REPO"] else { throw XCTSkip("set TEST_RUNNER_DRAY_START_REPO") }
        let app = try pair()
        openPage(app, "Pull requests")
        app.buttons["All"].firstMatch.tap()
        app.buttons["Filters"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Repository")).firstMatch.tap()
        let pick = app.buttons[repo].firstMatch
        XCTAssertTrue(pick.waitForExistence(timeout: 30), "no \(repo) in the repository menu")
        pick.tap()
        let row = app.buttons["pull.row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 60))
        row.tap()
        XCTAssertTrue(labelled(app, "Checks").waitForExistence(timeout: 60))
        let task = app.buttons["Task"].firstMatch
        if task.exists { task.tap() }
        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        for _ in 0..<12 where !field.isHittable { app.swipeUp() }
        field.tap()
        field.typeText("Reply with the single word OK. Run no tools, edit nothing, commit and push nothing.")
        app.swipeDown()
        let start = app.buttons["Start task"]
        for _ in 0..<6 where !start.isHittable { app.swipeUp() }
        sleep(1)
        snap(app, "20-start-filled")
        start.tap()
        let opened = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Pull request #")).firstMatch
        for _ in 0..<12 where !labelled(app, "Task").exists { sleep(5) }
        for _ in 0..<12 where !app.staticTexts["Task"].isHittable { app.swipeDown() }
        sleep(2)
        snap(app, "21-started")
        _ = opened
    }

    // MARK: Helpers

    private func openPage(_ app: XCUIApplication, _ name: String) {
        let button = app.buttons[name]
        XCTAssertTrue(button.waitForExistence(timeout: 30), "no \(name) button")
        button.tap()
    }

    private func labelled(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func pair() throws -> XCUIApplication {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "This Mac")]
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
