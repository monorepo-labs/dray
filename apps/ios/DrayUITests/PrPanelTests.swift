import XCTest

/// The PR sheet in every state, against a `dray-serve` behind
/// `scripts/pr_fixture_proxy.py`, which answers the PR commands from fixtures
/// keyed on each session's repo, so a merge lands on the fixture and never on
/// GitHub. Setup is in that script's header.
final class PrPanelTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testStates() throws {
        let app = try pair()
        for (session, state, expect) in [("PR running", "03-running", "Waiting on checks"),
                                         ("PR failing", "04-failing", "Checks not passing"),
                                         ("PR ready", "05-ready", "Ready to merge"),
                                         ("PR draft", "09-draft", "Draft"),
                                         ("PR loggedout", "08-logged-out", "GitHub CLI is logged out")] {
            openSheet(app, session)
            XCTAssertTrue(labelled(app, expect).waitForExistence(timeout: 15), "\(session): no \(expect)")
            sleep(1)
            snap(app, state)
            if state == "05-ready" {
                app.swipeUp()
                sleep(1)
                snap(app, "05-ready-comments")
            }
            closeSheet(app)
        }
    }

    /// The method menu, the pick sticking, the confirm, and the merge landing — on the fixture.
    func testMergeFlow() throws {
        let app = try pair()
        openSheet(app, "PR ready")
        let method = app.buttons["Merge method"]
        XCTAssertTrue(method.waitForExistence(timeout: 20), "no merge button")
        // A menu item's label is its title and subtitle joined.
        let item = { (title: String) in
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title + ",")).firstMatch
        }
        // The pick outlives a run, so an earlier one may have left another method saved.
        if !app.buttons["Squash and merge"].exists {
            method.tap()
            XCTAssertTrue(item("Squash and merge").waitForExistence(timeout: 5), "no method menu")
            item("Squash and merge").tap()
            XCTAssertTrue(app.buttons["Squash and merge"].waitForExistence(timeout: 5), "squash did not stick")
        }
        sleep(1)
        method.tap()
        XCTAssertTrue(item("Rebase and merge").waitForExistence(timeout: 5), "no method menu")
        sleep(1)
        snap(app, "06-method-menu")
        item("Create a merge commit").tap()
        XCTAssertTrue(app.buttons["Create a merge commit"].waitForExistence(timeout: 5), "the pick did not stick")
        sleep(1)
        app.buttons["Create a merge commit"].tap()
        let confirm = app.buttons.matching(NSPredicate(format: "label == %@", "Create a merge commit"))
        XCTAssertTrue(labelled(app, "Create a merge commit #812?").waitForExistence(timeout: 5), "no confirm")
        sleep(1)
        snap(app, "06b-confirm")
        confirm.element(boundBy: confirm.count - 1).tap()
        XCTAssertTrue(labelled(app, "Merged").waitForExistence(timeout: 15), "the merge did not land")
        sleep(1)
        snap(app, "07-merged")
    }

    func openSheet(_ app: XCUIApplication, _ session: String) {
        let row = labelled(app, session)
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no \(session)")
        row.tap()
        let pr = app.buttons["Pull request"]
        XCTAssertTrue(pr.waitForExistence(timeout: 20), "\(session): no PR button")
        pr.tap()
    }

    func closeSheet(_ app: XCUIApplication) {
        app.buttons["Done"].tap()
        sleep(1)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        sleep(1)
    }

    func labelled(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    func pair() throws -> XCUIApplication {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        // No `-pr.mergeMethod` here: an argument pins the default, so a pick could never stick.
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "boat")]
        app.open(link.url!)
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()
        return app
    }

    func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
