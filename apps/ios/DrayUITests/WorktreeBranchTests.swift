import XCTest

/// Run with's branch picks against a scratch `dray-serve` and a repo holding a
/// branch in every place the worktree picker sorts by: main behind its remote,
/// `feature/remote-only`, `local-only`, `shared` in both and just behind, and
/// `local-two` for the checkout switch, with an untracked file to make it ask.
/// The trees each start made are checked on the server's side afterwards.
///   TEST_RUNNER_DRAY_URL=… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_PROJECT=/private/tmp/bp/repo
/// Runs in name order: the last start needs `local-two` checked out by the one before.
final class WorktreeBranchTests: XCTestCase {
    func test1RemoteOnly() throws { try start(from: "feature/remote-only", search: "rem") }
    func test2LocalOnly() throws { try start(from: "local-only") }
    func test3Shared() throws { try start(from: "shared") }
    func test4Main() throws { try start(from: "main") }

    /// Worktree off: the branch row switches the checkout, asking first about the untracked file.
    func test5SwitchCheckout() throws {
        let app = try openRunWith()
        setWorktree(app, on: false)
        let row = app.buttons["row.Branch"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no Branch row")
        row.tap()
        let item = app.buttons["local-two"].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.tap()
        let bring = app.buttons["Bring changes"]
        XCTAssertTrue(bring.waitForExistence(timeout: 10), "no uncommitted-changes question")
        snap(app, "5-dirty-question")
        bring.tap()
        XCTAssertTrue(app.buttons["row.Branch"].staticTexts["local-two"].waitForExistence(timeout: 15), "checkout never switched")
        snap(app, "5-switched")
    }

    /// `local-two` is now the project folder's own branch, so its tree is detached.
    func test6HeldElsewhere() throws { try start(from: "local-two") }

    /// Back from the page, the sheet's title sits where it was, not under an empty bar.
    func test0BackKeepsSheet() throws {
        let app = try openRunWith()
        setWorktree(app, on: true)
        let done = app.buttons["Done"]
        let top = done.frame.minY
        app.buttons["row.Start from"].tap()
        XCTAssertTrue(app.navigationBars["Start from"].waitForExistence(timeout: 5))
        // Picked from a search, which is what left the bar behind.
        let field = app.searchFields["Filter branches"]
        field.tap()
        field.typeText("ma")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "main")).firstMatch.tap()
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        sleep(1)
        snap(app, "0-back")
        XCTAssertEqual(done.frame.minY, top, accuracy: 2, "sheet moved down after the page")
    }

    private func start(from branch: String, search: String? = nil) throws {
        let app = try openRunWith()
        setWorktree(app, on: true)
        let row = app.buttons["row.Start from"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no Start from row")
        row.tap()
        XCTAssertTrue(app.navigationBars["Start from"].waitForExistence(timeout: 5))
        snap(app, "\(branch)-list")
        if let search {
            let field = app.searchFields["Filter branches"]
            field.tap()
            field.typeText(search)
            snap(app, "\(branch)-search")
        }
        let pick = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", branch)).firstMatch
        XCTAssertTrue(pick.waitForExistence(timeout: 5), "\(branch) not listed")
        pick.tap()
        XCTAssertTrue(row.staticTexts[branch].waitForExistence(timeout: 5), "row does not say \(branch)")
        snap(app, "\(branch)-picked")
        app.buttons["Done"].tap()

        app.buttons["Keyboard"].tap()
        let prompt = app.textViews["New task"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        prompt.typeText("Reply OK. case=\(branch)")
        app.buttons["Done"].tap()
        app.buttons["Start task"].tap()
        let sent = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "case=\(branch)")).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 60), "task never started")
        snap(app, "\(branch)-started")
    }

    /// Launches with only the server under test, and opens Run with on the
    /// project, attaching it by path the first time.
    private func openRunWith() throws -> XCUIApplication {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let project = env["DRAY_PROJECT"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN and TEST_RUNNER_DRAY_PROJECT")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        app.buttons["Enter an address"].tap()
        let address = app.textFields["Address"]
        address.tap()
        address.typeText(url)
        let secret = app.textFields["Token"]
        secret.tap()
        secret.typeText(token)
        app.buttons["Add"].tap()
        XCTAssertTrue(app.buttons["Keyboard"].waitForExistence(timeout: 30))

        app.buttons["Project"].firstMatch.tap()
        let attach = app.buttons["Attach project"]
        if attach.waitForExistence(timeout: 5) {
            attach.tap()
            XCTAssertTrue(app.buttons["Enter path"].waitForExistence(timeout: 15))
            app.buttons["Enter path"].tap()
            let path = app.alerts.textFields.firstMatch
            XCTAssertTrue(path.waitForExistence(timeout: 5))
            path.typeText(project)
            app.alerts.buttons["Attach"].tap()
            XCTAssertTrue(app.staticTexts[(project as NSString).lastPathComponent].waitForExistence(timeout: 15))
        }
        return app
    }

    private func setWorktree(_ app: XCUIApplication, on: Bool) {
        let toggle = app.switches["Worktree"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 15))
        let isOn = ["On", "1"].contains(toggle.value as? String ?? "")
        if isOn != on { toggle.tap() }
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
