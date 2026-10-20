import XCTest

/// Opens the PR sheet against a live `dray-serve` whose sessions sit on real
/// branches: one with an open PR, one merged, one with none. Reads only — the
/// merge dialog is opened and cancelled, never confirmed.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:7399 TEST_RUNNER_DRAY_TOKEN=… xcodebuild test …
final class PrPanelTests: XCTestCase {
    func testPrSheet() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launch()
        // The empty list's own button: through the Servers sheet there are two, and
        // which one `firstMatch` takes is not stable. Wants a fresh install.
        app.buttons["Add server"].firstMatch.tap()
        app.textFields["Address"].tap()
        app.textFields["Address"].typeText(url)
        app.textFields["Token"].tap()
        app.textFields["Token"].typeText(token)
        app.buttons["Add"].tap()

        // Open PR: readiness, checks, the merge dialog.
        open(app, "Open PR session")
        let pr = app.buttons["Pull request"]
        XCTAssertTrue(pr.waitForExistence(timeout: 30), "no PR button")
        pr.tap()
        XCTAssertTrue(app.staticTexts["Checks"].waitForExistence(timeout: 15), "no checks")
        snap(app, "1-open-pr")
        app.swipeUp()
        snap(app, "2-open-pr-comments")
        app.swipeDown()
        let merge = app.buttons["Merge…"]
        XCTAssertTrue(merge.waitForExistence(timeout: 5), "no merge button on an open PR")
        merge.tap()
        XCTAssertTrue(app.buttons["Squash and merge"].waitForExistence(timeout: 5))
        snap(app, "3-merge-dialog")
        // iOS 27 draws the dialog as a popover with no Cancel; a tap outside dismisses it.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
        XCTAssertTrue(app.buttons["Squash and merge"].waitForNonExistence(timeout: 5))
        app.buttons["Done"].tap()
        back(app)

        // Merged: the verdict, and no action.
        open(app, "Merged PR session")
        XCTAssertTrue(pr.waitForExistence(timeout: 30))
        pr.tap()
        XCTAssertTrue(app.staticTexts["Merged"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Merge…"].exists)
        snap(app, "4-merged-pr")
        app.buttons["Done"].tap()
        back(app)

        // No PR: no button.
        open(app, "No PR session")
        sleep(8)
        XCTAssertFalse(pr.exists, "button drawn for a branch with no PR")
        snap(app, "5-no-pr")
    }

    private func open(_ app: XCUIApplication, _ title: String) {
        let row = app.staticTexts[title]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no \(title)")
        row.tap()
    }

    private func back(_ app: XCUIApplication) {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
