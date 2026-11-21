import XCTest

/// The pull requests and issues pages against a real `dray-serve` whose `gh`
/// is signed in, so the rows are GitHub's own:
///
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… xcodebuild test -only-testing:DrayUITests/PullsIssuesTests
///
/// `testStartTask` starts two real tasks on the reader's PR titled `TEST_RUNNER_DRAY_PR_TITLE`,
/// one plain and one in the bot `TEST_RUNNER_DRAY_BOT`, both told to read and change nothing.
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

    /// Where the two pages are reached: the task list's top bar, beside Settings.
    func testEntry() throws {
        let app = try pair()
        XCTAssertTrue(app.buttons["Issues"].waitForExistence(timeout: 30))
        sleep(3)
        screen("00-entry")
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
        guard let title = env["DRAY_PR_TITLE"], let bot = env["DRAY_BOT"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_PR_TITLE and TEST_RUNNER_DRAY_BOT")
        }
        // A new task's remembered picks, so the plain task starts on haiku at low effort.
        let app = try pair(["-new.harness", "claude_code", "-new.models", "{claude_code = haiku;}",
                            "-new.efforts", "{haiku = low;}", "-new.fast", "NO"])
        openPage(app, "Pull requests")
        app.buttons["Mine"].firstMatch.tap()
        let pr = app.buttons.matching(identifier: "pull.row").matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(app.buttons["pull.row"].firstMatch.waitForExistence(timeout: 60))
        // Rows are lazy: a draft at the foot exists only once scrolled to.
        for _ in 0..<12 where !pr.isHittable { app.swipeUp(velocity: .slow) }
        pr.tap()
        sleep(10)
        let words = "Summarise this pull request in three short lines. Read only: change nothing, write no files, commit and push nothing."
        start(app, chip: "Task", button: "Start task", words: words, shot: "20-task-filled")
        start(app, chip: bot, button: "Start in \(bot)", words: words, shot: "21-bot-filled")
        for _ in 0..<8 { app.swipeDown(velocity: .fast) }
        sleep(20)
        screen("22-tasks-listed")
        sleep(60)
        screen("23-tasks-later")
    }

    private func start(_ app: XCUIApplication, chip: String, button: String, words: String, shot: String) {
        // The bot's row in the task list behind the sheet carries its name too.
        let pick = chip == "Task" ? app.buttons["Task"].firstMatch
            : app.buttons.matching(NSPredicate(format: "identifier == 'bot.chip' AND label == %@", chip)).firstMatch
        for _ in 0..<8 where !pick.isHittable { app.swipeUp(velocity: .slow) }
        for _ in 0..<8 where !pick.isHittable { app.swipeDown(velocity: .slow) }
        pick.tap()
        sleep(2)
        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        for _ in 0..<6 where !field.isHittable { app.swipeUp(velocity: .slow) }
        field.tap()
        field.typeText(words)
        let go = app.buttons[button]
        for _ in 0..<6 where !go.isHittable { app.swipeUp(velocity: .slow) }
        sleep(1)
        screen(shot)
        go.tap()
        // Started once the box empties again.
        for _ in 0..<90 where (field.value as? String ?? "").contains("Summarise") { sleep(2) }
        sleep(2)
        screen(shot.replacingOccurrences(of: "filled", with: "started"))
        XCTAssertFalse((field.value as? String ?? "").contains("Summarise"), "\(button) started nothing")
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
