import XCTest

/// A server already saved, linked again under another name or pasted as another
/// spelling of its address, is updated in place: one card in Settings, its bot once (#1244).
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=Ops xcodebuild test …
final class DuplicateServerTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testSameServerTwice() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let bot = env["DRAY_BOT"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, _TOKEN and _BOT")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        link(app, url: url, token: token, name: "Studio Mac")
        app.buttons["Add"].tap()
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "\(bot), "))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 20), "no bot row")
        sleep(1)

        // The same link again, named otherwise.
        link(app, url: url, token: token, name: "Office Mac")
        XCTAssertTrue(app.staticTexts["This server is already added as Studio Mac."].waitForExistence(timeout: 5), "no already-added note")
        XCTAssertFalse(app.buttons["Add"].exists, "Add still offered for a saved server")
        sleep(2)
        app.buttons["Update"].tap()

        // Pasted as another spelling of the address.
        app.buttons["Settings"].tap()
        app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Add server'")).firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Add server"].waitForExistence(timeout: 5))
        app.staticTexts["Address"].tap()
        app.typeText("\(url.replacingOccurrences(of: "ws://", with: "http://"))/ \(token)")
        XCTAssertTrue(app.staticTexts["This server is already added as Studio Mac."].waitForExistence(timeout: 5), "a pasted copy reads as new")
        sleep(2)
        app.buttons["Update"].tap()

        sleep(1)
        XCTAssertEqual(app.staticTexts.matching(identifier: "Studio Mac").count, 1, "a second card in Settings")
        XCTAssertFalse(app.staticTexts["Office Mac"].exists)
        app.buttons["Done"].tap()
        sleep(3)
        XCTAssertEqual(rows.count, 1, "the bot shows twice")
    }

    private func link(_ app: XCUIApplication, url: String, token: String, name: String) {
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: name)]
        // Not `app.open`, which relaunches with `-servers ""` and forgets the first add.
        XCUIDevice.shared.system.open(link.url!)
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        XCTAssertTrue(app.navigationBars["Add server"].waitForExistence(timeout: 10), "the link opened no add sheet")
    }
}
