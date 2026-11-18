import XCTest

/// iOS 26 and up, against a server that can't transcribe (a plain `dray-serve`):
/// the orb stays, Settings › Dictation defaults to Apple, and a recording comes
/// back read on the phone — words, or "No words heard." in a quiet room. Grant
/// the microphone first:
///   xcrun simctl privacy booted grant microphone com.yogesh.dray.ios
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… xcodebuild test -only-testing:DrayUITests/AppleDictationTests
final class AppleDictationTests: XCTestCase {
    func testDictateOnThePhone() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-dictation.server", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Linux box")]
        app.open(link.url!)
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()

        let orb = app.descendants(matching: .any)["orb"]
        XCTAssertTrue(orb.waitForExistence(timeout: 20), "keyboard mode where Apple can transcribe")
        sleep(2)
        snap(app, "1-list")

        app.buttons["Settings"].tap()
        let row = labelled(app, "Dictation")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(labelled(app, "iPhone").exists, "Settings doesn't name the iPhone as the engine")
        sleep(1)
        snap(app, "2-settings")
        row.tap()
        let apple = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'iPhone'")).firstMatch
        XCTAssertTrue(apple.waitForExistence(timeout: 5), "no iPhone row")
        XCTAssertTrue(apple.isSelected, "Apple isn't the default with no server able")
        sleep(2)
        snap(app, "3-dictation")
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Done"].tap()

        orb.tap()
        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10), "recording never started")
        snap(app, "4-recording")
        sleep(3)
        done.tap()

        // The first read downloads the model, which can take minutes. The
        // simulator's analyzer offers no audio format, so there it ends at Retry.
        let heard = app.buttons.matching(NSPredicate(format: "label == 'Start task' AND isEnabled == true"))
        let silent = app.staticTexts["No words heard."]
        let retry = app.buttons["Retry"]
        for _ in 0..<300 where heard.count == 0 && !silent.exists && !retry.exists { sleep(1) }
        snap(app, "5-answered")
        XCTAssertTrue(heard.count > 0 || silent.exists, "Apple's answer never landed")
    }

    private func labelled(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
