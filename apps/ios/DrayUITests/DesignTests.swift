import XCTest

/// Walks every screen and state, attaching a screenshot of each, so a design
/// change can be looked at whole. Reads only: no turn is run, nothing merged.
///
/// Wants the scratch server `SmokeTests` describes for the tour, and two
/// stand-ins for the failure states (`/tmp/dray631-fake.py` in #631): one
/// refusing the hello as a newer server, one admitting and then refusing every
/// call. Export the shots with `xcrun xcresulttool export attachments`.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=…
///   TEST_RUNNER_DRAY_FAKE_PROTOCOL=ws://127.0.0.1:… TEST_RUNNER_DRAY_FAKE_BROKEN=ws://127.0.0.1:…
///   TEST_RUNNER_DRAY_RECONNECT_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_STOP_FILE=/tmp/…
final class DesignTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testTour() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = launch()
        snap(app, "01-onboarding")

        app.buttons["Add server"].firstMatch.tap()
        fill(app, url: url, token: token, name: "Studio Mac")
        snap(app, "02-add-server")
        app.buttons["Add"].tap()

        let row = app.staticTexts["Phone smoke"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no session listed")
        // Marks need `gh` on the server's side.
        _ = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Pull request #'"))
            .firstMatch.waitForExistence(timeout: 30)
        snap(app, "03-list")

        app.buttons["Project filter"].tap()
        snap(app, "04-project-menu")
        app.buttons["dray-541-gh"].tap()
        snap(app, "05-list-filtered")
        app.buttons["Project filter"].tap()
        app.buttons["All projects"].tap()

        row.tap()
        let message = app.textFields["Message"]
        XCTAssertTrue(message.waitForExistence(timeout: 15))
        sleep(2)
        snap(app, "06-transcript")
        let fold = app.buttons.matching(NSPredicate(format: "label CONTAINS 'tool call'")).firstMatch
        if fold.exists {
            fold.tap()
            sleep(1)
            snap(app, "07-turn-open")
        }
        app.swipeDown()
        app.swipeDown()
        snap(app, "08-transcript-top")
        message.tap()
        message.typeText("Tighten the spacing on the session rows")
        snap(app, "09-composer-typed")
        app.buttons["Local servers"].tap()
        sleep(3)
        snap(app, "10-local-servers")
        app.buttons["Done"].tap()
        back(app)

        app.staticTexts["Open PR work"].tap()
        let pr = app.buttons["Pull request"]
        if pr.waitForExistence(timeout: 30) {
            snap(app, "11-transcript-pr-button")
            pr.tap()
            _ = app.staticTexts["Checks"].waitForExistence(timeout: 15)
            snap(app, "12-pr-sheet")
            app.swipeUp()
            snap(app, "13-pr-sheet-comments")
            app.buttons["Done"].tap()
        }
        back(app)

        app.buttons["Settings"].tap()
        XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 10))
        snap(app, "14-settings")
        app.staticTexts["Studio Mac"].tap()
        snap(app, "15-server-detail")
        back(app)
        app.buttons["Done"].tap()

        app.buttons["New session"].firstMatch.tap()
        let prompt = app.textFields["Prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 15))
        sleep(2)
        snap(app, "16-new-session")
        prompt.tap()
        prompt.typeText("Add a dark mode toggle to the settings page")
        snap(app, "17-new-session-typed")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model'")).firstMatch.tap()
        snap(app, "18-model-menu")
    }

    func testFailureStates() throws {
        guard let url = env["DRAY_URL"], let newer = env["DRAY_FAKE_PROTOCOL"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_FAKE_PROTOCOL")
        }
        let app = launch()
        addServer(app, url: url, token: String(repeating: "0", count: 64), name: "Office Mac")
        app.buttons["Settings"].tap()
        addServer(app, url: "ws://127.0.0.1:7699", token: String(repeating: "a", count: 64), name: "Home server")
        addServer(app, url: newer, token: String(repeating: "b", count: 64), name: "Build box")
        snap(app, "19-settings-failures")
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Office Mac refused the token"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Can't reach Home server"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["This app needs an update"].waitForExistence(timeout: 15))
        sleep(1)
        snap(app, "20-failures-list")
        app.buttons["Fix"].firstMatch.tap()
        sleep(1)
        snap(app, "21-fix-token")
    }

    func testBrokenServer() throws {
        guard let broken = env["DRAY_FAKE_BROKEN"] else { throw XCTSkip("set TEST_RUNNER_DRAY_FAKE_BROKEN") }
        let app = launch()
        allowMicrophone()
        addServer(app, url: broken, token: String(repeating: "c", count: 64), name: "Flaky box")
        let row = app.staticTexts["Broken session"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        XCTAssertTrue(app.staticTexts["Couldn't load this session"].waitForExistence(timeout: 15))
        snap(app, "30-failed-load")

        let message = app.textFields["Message"]
        message.tap()
        message.typeText("Run the tests again")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.buttons["Retry"].waitForExistence(timeout: 15), "no failed-send retry")
        snap(app, "31-failed-send")

        app.buttons["dictate"].tap()
        app.tap()  // lets the interruption monitor answer the microphone prompt
        let stop = app.buttons["Stop dictation"]
        if stop.waitForExistence(timeout: 10) {
            sleep(2)
            snap(app, "32-recording")
            stop.tap()
            snap(app, "33-transcribing")
            _ = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH \"Couldn't transcribe\"")).firstMatch
                .waitForExistence(timeout: 30)
            snap(app, "34-dictation-failed")
        }
        back(app)

        app.buttons["New session"].firstMatch.tap()
        XCTAssertTrue(app.textFields["Prompt"].waitForExistence(timeout: 15))
        sleep(2)
        snap(app, "35-new-session-failed-load")
        if app.buttons["dictate"].exists {
            app.buttons["dictate"].tap()
            if app.buttons["Stop dictation"].waitForExistence(timeout: 10) {
                sleep(2)
                snap(app, "36-new-session-recording")
                app.buttons["Cancel dictation"].tap()
            }
        }
    }

    func testOffline() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = launch(offline: true)
        addServer(app, url: url, token: token, name: "Studio Mac")
        XCTAssertTrue(app.staticTexts["You're offline"].waitForExistence(timeout: 10))
        sleep(2)
        snap(app, "40-offline")
    }

    func testReconnecting() throws {
        // A server of its own, since this one is stopped: `/tmp/dray631-reconnect.sh` in #631.
        guard let url = env["DRAY_RECONNECT_URL"], let token = env["DRAY_TOKEN"], let stopAt = env["DRAY_STOP_FILE"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_RECONNECT_URL, TEST_RUNNER_DRAY_TOKEN and TEST_RUNNER_DRAY_STOP_FILE")
        }
        let app = launch()
        addServer(app, url: url, token: token, name: "Studio Mac")
        let row = app.staticTexts["Phone smoke"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        XCTAssertTrue(app.textFields["Message"].waitForExistence(timeout: 15))
        // The harness watches for this file and stops the server.
        FileManager.default.createFile(atPath: stopAt, contents: nil)
        XCTAssertTrue(app.staticTexts["Can't reach Studio Mac"].waitForExistence(timeout: 60), "never noticed the server go")
        snap(app, "50-session-server-down")
        back(app)
        snap(app, "51-list-server-down")
    }

    // MARK: Helpers

    /// A fresh app with no saved servers: the argument hides whatever an earlier run left.
    private func launch(offline: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""] + (offline ? ["-offline"] : [])
        app.launch()
        return app
    }

    /// Taps whichever Add server is on screen: the empty list's, or Settings' once one is saved.
    private func addServer(_ app: XCUIApplication, url: String, token: String, name: String) {
        app.buttons["Add server"].firstMatch.tap()
        fill(app, url: url, token: token, name: name)
        app.buttons["Add"].tap()
    }

    private func fill(_ app: XCUIApplication, url: String, token: String, name: String) {
        let address = app.textFields["Address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap()
        address.typeText(url)
        app.textFields["Token"].tap()
        app.textFields["Token"].typeText(token)
        app.textFields["Name"].tap()
        app.textFields["Name"].typeText(name)
    }

    private func allowMicrophone() {
        addUIInterruptionMonitor(withDescription: "Microphone") { alert in
            for label in ["Allow", "OK"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
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
