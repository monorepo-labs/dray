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
        XCTAssertTrue(app.buttons["Start a task"].waitForExistence(timeout: 30))
        sleep(3)
        snap(app, "12-issue-github")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        sleep(1)
        app.buttons["Linear"].firstMatch.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 60), "Linear drew no issue")
        sleep(2)
        snap(app, "13-issues-linear")
        row.tap()
        XCTAssertTrue(app.buttons["Start a task"].waitForExistence(timeout: 30))
        sleep(3)
        snap(app, "14-issue-linear")
    }

    /// The PR titled `TEST_RUNNER_DRAY_PR_TITLE`: a comment opening in place, Share's sheet, and play's
    /// start sheet starting a real task, haiku told to read and change nothing. With `TEST_RUNNER_DRAY_BOT`,
    /// a second task goes to that bot.
    func testStartTask() throws {
        guard let title = env["DRAY_PR_TITLE"] else { throw XCTSkip("set TEST_RUNNER_DRAY_PR_TITLE") }
        let app = try pair(haiku)
        openPage(app, "Pull requests")
        app.buttons["All"].firstMatch.tap()
        let pr = app.buttons.matching(identifier: "pull.row").matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(app.buttons["pull.row"].firstMatch.waitForExistence(timeout: 60))
        // Rows are lazy: a draft at the foot exists only once scrolled to.
        for _ in 0..<12 where !pr.isHittable { app.swipeUp(velocity: .slow) }
        pr.tap()
        sleep(12)
        screen("20-pr-page")
        let comment = app.descendants(matching: .any).matching(identifier: "pr.comment").firstMatch
        for _ in 0..<12 where !comment.isHittable { app.swipeUp(velocity: .slow) }
        sleep(1)
        screen("21-pr-comment-closed")
        comment.tap()
        sleep(2)
        screen("22-pr-comment-open")
        share(app, "23-pr-share")
        start(app, chip: "Task", words: readOnly, shot: "24-pr-sheet")
        if let bot = env["DRAY_BOT"] { start(app, chip: bot, words: readOnly, shot: "26-pr-bot") }
        for _ in 0..<8 { app.swipeDown(velocity: .fast) }
        sleep(15)
        screen("27-pr-tasks-listed")
    }

    /// The GitHub issue titled `TEST_RUNNER_DRAY_ISSUE_TITLE`: Share, then play's sheet starting a real
    /// task on it right there, which opens. With `TEST_RUNNER_DRAY_BOT`, it is sent to that bot first.
    func testStartIssueTask() throws {
        guard let title = env["DRAY_ISSUE_TITLE"] else { throw XCTSkip("set TEST_RUNNER_DRAY_ISSUE_TITLE") }
        // GitHub from the start: a server with no Linear key opens on Connect Linear, with no switch on it.
        let app = try pair(haiku + ["-issues.tracker", "github"])
        openPage(app, "Issues")
        let repo = app.buttons["issue.repo"].firstMatch
        if repo.waitForExistence(timeout: 15) { repo.tap() }
        app.buttons["All"].firstMatch.tap()
        let row = app.buttons.matching(identifier: "issue.row").matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(app.buttons["issue.row"].firstMatch.waitForExistence(timeout: 60), "GitHub drew no issue")
        for _ in 0..<12 where !row.isHittable { app.swipeUp(velocity: .slow) }
        row.tap()
        XCTAssertTrue(app.buttons["Start a task"].waitForExistence(timeout: 30))
        sleep(5)
        screen("30-issue-page")
        share(app, "31-issue-share")
        if let bot = env["DRAY_BOT"] { start(app, chip: bot, words: readOnly, shot: "32-issue-bot") }
        start(app, chip: "Task", words: readOnly, shot: "34-issue-sheet")
        sleep(15)
        screen("36-issue-task-later")
    }

    private let haiku = ["-new.harness", "claude_code", "-new.models", "{claude_code = haiku;}",
                         "-new.efforts", "{haiku = low;}", "-new.fast", "NO", "-new.worktree", "YES"]
    private let readOnly = "Summarise this in three short lines. Read only: change nothing, write no files, commit and push nothing."

    /// Share opens the system's sheet, which is shot and closed again.
    private func share(_ app: XCUIApplication, _ shot: String) {
        app.navigationBars.buttons["Share"].tap()
        sleep(3)
        screen(shot)
        // A popover with no Close: a tap below it puts it away, and goes no further.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)).tap()
        sleep(2)
        XCTAssertTrue(app.navigationBars.buttons["Start a task"].isHittable, "the share sheet stayed up")
    }

    /// Play opens the start sheet; the chip and words are picked, and Start makes the task and closes the sheet.
    private func start(_ app: XCUIApplication, chip: String, words: String, shot: String) {
        app.navigationBars.buttons["Start a task"].tap()
        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10), "play opened no sheet")
        sleep(2)
        screen(shot + "-open")
        let pick = chip == "Task" ? app.buttons["Task"].firstMatch
            : app.buttons.matching(NSPredicate(format: "identifier == 'bot.chip' AND label == %@", chip)).firstMatch
        if pick.exists { pick.tap() }
        field.typeText(words)
        sleep(4)
        screen(shot)
        let go = app.buttons.matching(NSPredicate(format: "label == 'Start task' OR label BEGINSWITH 'Start in ' OR label BEGINSWITH 'Send to '")).firstMatch
        go.tap()
        // Started once the sheet has gone.
        for _ in 0..<60 where field.exists { sleep(2) }
        XCTAssertFalse(field.exists, "the sheet never started its task")
        sleep(3)
        screen(shot + "-started")
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
