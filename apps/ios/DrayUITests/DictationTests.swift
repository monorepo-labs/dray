import XCTest

/// Dictates into a session's composer against a Mac server (`dray --serve`),
/// whose welcome frame offers dictation: record, stop, and see the server's
/// answer land — words in the draft, or its sentence under the composer.
///
/// Grant the microphone first, after any uninstall, or the system
/// prompt takes the tap:
///   xcrun simctl privacy booted grant microphone com.yogesh.dray.ios
/// and pass the server as SmokeTests does:
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… xcodebuild test …
final class DictationTests: XCTestCase {
    func testDictateAndGetAnAnswer() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        // Hides saved servers, so the empty list's own Add server is the one on screen.
        app.launchArguments = ["-servers", ""]
        app.launch()

        app.buttons["Add server"].firstMatch.tap()
        let address = app.textFields["Address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap()
        address.typeText(url)
        let secret = app.textFields["Token"]
        secret.tap()
        secret.typeText(token)
        app.buttons["Add"].tap()

        let row = app.collectionViews.cells.firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no session listed")
        row.tap()

        let orb = app.descendants(matching: .any)["orb"]
        XCTAssertTrue(orb.waitForExistence(timeout: 15), "no dock in the session")
        snap(app, "1-orb")
        orb.press(forDuration: 0.6)

        let stop = app.buttons["Done"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "recording never started")
        snap(app, "2-recording")
        sleep(3)
        stop.tap()

        // A real answer from the model: words in the draft, or the sentence
        // for silence. A failed upload or an unreadable reply shows neither.
        let heard = app.buttons.matching(NSPredicate(format: "label == 'Send' AND isEnabled == true"))
        let silent = app.staticTexts["No words heard."]
        for _ in 0..<90 where heard.count == 0 && !silent.exists { sleep(1) }
        XCTAssertTrue(heard.count > 0 || silent.exists, "the server's answer never landed")
        snap(app, "3-answered")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
