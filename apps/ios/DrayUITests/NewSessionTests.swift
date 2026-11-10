import XCTest

/// Starts a task from the phone's dock and sees its first reply, against a scratch
/// `dray-serve`. Attaches the project by path first, so the server needs
/// nothing but a git repo on disk:
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:7399 TEST_RUNNER_DRAY_TOKEN=…
///   TEST_RUNNER_DRAY_PROJECT=/tmp/…/repo xcodebuild test …
///
/// Runs before `SmokeTests`, and leaves it what it wants: a newest session in
/// `manual` stance.
final class NewSessionTests: XCTestCase {
    func testStartSessionAndSeeReply() throws {
        let env = ProcessInfo.processInfo.environment
        guard let project = ProcessInfo.processInfo.environment["DRAY_PROJECT"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_PROJECT")
        }
        let app = try openNewSession()

        pick(app, "Project", "Attach project…")
        XCTAssertTrue(app.buttons["Enter path"].waitForExistence(timeout: 15))
        snap(app, "1-attach")
        app.buttons["Enter path"].tap()
        let path = app.alerts.textFields.firstMatch
        XCTAssertTrue(path.waitForExistence(timeout: 5))
        path.typeText(project)
        app.alerts.buttons["Attach"].tap()

        XCTAssertTrue(app.staticTexts[(project as NSString).lastPathComponent].waitForExistence(timeout: 15))
        app.buttons["Keyboard"].tap()
        let prompt = app.textViews["New task"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        prompt.typeText("Reply with the single word HELLO and nothing else.")
        app.buttons["Done"].tap()

        pick(app, "Model", "Haiku 5.5")
        pick(app, "More picks", "Permissions", "Ask every time")
        snap(app, "2-new-task")

        app.buttons["Start task"].tap()

        let reply = app.staticTexts["HELLO"]
        XCTAssertTrue(reply.waitForExistence(timeout: 120), "reply never landed")
        snap(app, "3-reply")
    }

    /// Clones a repo from the server's GitHub account into `~/dray` — the real
    /// home, not `DRAY_HOME` — so it only runs when handed a small one to clone:
    ///   TEST_RUNNER_DRAY_CLONE=owner/repo
    func testCloneFromGithub() throws {
        guard let slug = ProcessInfo.processInfo.environment["DRAY_CLONE"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_CLONE to a small repo of the server's GitHub account")
        }
        let app = try openNewSession()
        pick(app, "Project", "Attach project…")

        // Rows are lazy: one below the fold does not exist until searched for.
        let search = app.searchFields["Search repositories"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        search.tap()
        search.typeText(slug)
        snap(app, "1-searched")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", slug)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 60), "\(slug) not listed")
        snap(app, "1-repos")
        row.tap()
        app.buttons["Clone into ~/dray"].tap()
        snap(app, "2-cloning")

        let name = String(slug.split(separator: "/").last ?? "")
        XCTAssertTrue(app.staticTexts[name].waitForExistence(timeout: 120), "clone never attached")
        snap(app, "3-attached")
    }

    /// Launches with no saved servers and adds the one under test, so servers
    /// left over from earlier runs cannot change the answer.
    private func openNewSession() throws -> XCUIApplication {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        app.buttons["Add server"].firstMatch.tap()
        let address = app.textFields["Address"]
        address.tap()
        address.typeText(url)
        let secret = app.textFields["Token"]
        secret.tap()
        secret.typeText(token)
        app.buttons["Add"].tap()
        // The dock is drawn once the server is connected.
        XCTAssertTrue(app.buttons["Keyboard"].waitForExistence(timeout: 30))
        return app
    }

    /// Opens one of the dock's pick menus and walks down it, submenu by submenu.
    private func pick(_ app: XCUIApplication, _ menu: String, _ path: String...) {
        let button = app.buttons[menu].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 15), "no \(menu) menu")
        button.tap()
        for option in path {
            let item = app.buttons[option].firstMatch
            XCTAssertTrue(item.waitForExistence(timeout: 5), "no \(option) in \(menu)")
            item.tap()
        }
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
