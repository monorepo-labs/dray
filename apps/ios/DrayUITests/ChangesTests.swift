import XCTest

/// #1326 against a real server: a task with commits and, with `DRAY_DIRTY`, uncommitted
/// edits. The Changes button, each of its views, a file's diff and a commit's.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_TASK="<title>"
///   xcodebuild test -only-testing:DrayUITests/ChangesTests
final class ChangesTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testChangesViews() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let task = env["DRAY_TASK"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, _TOKEN and _TASK")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()

        let row = labelled(app, task)
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no \(task)")
        row.tap()
        let button = app.buttons["Changes"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "no Changes button")
        // Under `pr_fixture_proxy.py`, a `pr-ready` repo has a PR, so the bar holds every button.
        if env["DRAY_PR"] != nil {
            XCTAssertTrue(app.buttons["Pull request"].waitForExistence(timeout: 20), "no PR button")
        }
        sleep(3)
        snap(app, "01-top-bar")
        button.tap()

        // `DRAY_DIRTY=1`: the task's tree holds uncommitted work, so the screen opens on it.
        // Unset: a clean tree, no Uncommitted tab, and the screen opens on Branch.
        let branchTab = app.buttons["Branch"]
        XCTAssertTrue(branchTab.waitForExistence(timeout: 20), "no Branch tab")
        if env["DRAY_DIRTY"] != nil {
            XCTAssertTrue(app.buttons["Uncommitted"].exists, "no Uncommitted tab on a dirty tree")
            XCTAssertTrue(app.staticTexts["count.ts"].waitForExistence(timeout: 20), "uncommitted lists no count.ts")
            sleep(1)
            snap(app, "02-uncommitted")
            app.staticTexts["count.ts"].tap()
            XCTAssertTrue(labelled(app, "src/count.ts").waitForExistence(timeout: 20), "no diff")
            sleep(1)
            snap(app, "03-diff")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            branchTab.tap()
        } else {
            XCTAssertTrue(app.staticTexts["README.md"].waitForExistence(timeout: 20), "did not open on Branch")
            XCTAssertFalse(app.buttons["Uncommitted"].exists, "Uncommitted shows on a clean tree")
        }
        XCTAssertTrue(app.staticTexts["README.md"].waitForExistence(timeout: 20), "branch lists no README.md")
        sleep(1)
        snap(app, "05-branch")
        app.staticTexts["README.md"].tap()
        sleep(2)
        snap(app, "06-branch-diff")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        app.buttons["Commits"].tap()
        let commit = app.staticTexts["Count characters too"]
        XCTAssertTrue(commit.waitForExistence(timeout: 20), "no commit row")
        sleep(1)
        snap(app, "07-commits")
        commit.tap()
        XCTAssertTrue(app.staticTexts["main.ts"].waitForExistence(timeout: 20), "the commit lists no main.ts")
        sleep(1)
        snap(app, "08-commit")
        app.staticTexts["main.ts"].tap()
        sleep(2)
        snap(app, "09-commit-diff")
    }

    private func labelled(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
