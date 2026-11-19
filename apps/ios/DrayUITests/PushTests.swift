import XCTest

/// #1299 end to end on the simulator: pair with a real server, allow
/// notifications, then answer each alert from the alert itself with the app away.
/// A local relay and `scripts/fake_apns.mjs` stand in for drayhq.com and APNs.
/// The server is driven from outside, in this order: a permission ask whose
/// command names "Bash" and whose turn ends "File made", a question about a
/// color answered "Green", then a bot named Pip starting its chat.
///   TEST_RUNNER_DRAY_URL=… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_RELAY=http://127.0.0.1:… TEST_RUNNER_DRAY_DRESS=… \
///     xcodebuild test -only-testing:DrayUITests/PushTests
final class PushTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    func testAlerts() throws {
        let app = try paired()
        XCUIDevice.shared.press(.home)

        let ask = banner("label CONTAINS 'Bash'")
        snap(springboard, "1-permission")
        ask.press(forDuration: 1.2)
        XCTAssertTrue(springboard.buttons["Deny"].waitForExistence(timeout: 5), "no Deny on the permission alert")
        snap(springboard, "2-permission-actions")
        springboard.buttons["Allow"].tap()

        _ = banner("label CONTAINS[c] 'File made'")
        snap(springboard, "3-done")

        try dressed(app, "question")
        let question = banner("label CONTAINS[c] 'color'")
        snap(springboard, "4-question")
        question.press(forDuration: 1.2)
        XCTAssertTrue(springboard.buttons["Green"].waitForExistence(timeout: 5), "the question's options are not on its alert")
        snap(springboard, "5-question-options")
        springboard.buttons["Green"].tap()

        _ = banner("label ENDSWITH[c] 'Green' OR label ENDSWITH[c] 'Green.'")
        snap(springboard, "6-question-done")

        try dressed(app, "bot")
        let bot = banner("label CONTAINS 'Pip'")
        snap(springboard, "7-bot-done")
        bot.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "tapping the alert did not open Dray")
        XCTAssertTrue(app.dock.waitForExistence(timeout: 15), "tapping the alert opened no chat")
        sleep(2)
        snap(app, "8-bot-chat")
    }

    /// A merge card going up raises Ready to merge, and tapping it opens that chat.
    /// The server is driven with a task titled "Fix login redirect" whose card names PR 1308.
    func testReadyToMerge() throws {
        let app = try paired()
        XCUIDevice.shared.press(.home)
        let ready = banner("label CONTAINS 'ready to merge'")
        sleep(1)
        snap(springboard, "ready")
        ready.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "tapping the alert did not open Dray")
        XCTAssertTrue(app.dock.waitForExistence(timeout: 15), "tapping the alert opened no chat")
        sleep(2)
        snap(app, "ready-chat")
    }

    /// Settings → Notifications: the main switch takes this phone's handle back
    /// from the server and hands a new one over, and a kind's switch tells the
    /// server to skip it. `TEST_RUNNER_DRAY_PUSH_FILE` is the test server's `push.json`.
    func testSettingsSwitch() throws {
        guard let file = env["DRAY_PUSH_FILE"] else { throw XCTSkip("set TEST_RUNNER_DRAY_PUSH_FILE") }
        let read = { (try? String(contentsOfFile: file, encoding: .utf8)) ?? "" }
        let held = { read().contains("dph_") }
        let app = try paired()
        for _ in 0..<20 where !held() { sleep(1) }
        XCTAssertTrue(held(), "the server holds no handle after pairing")
        app.buttons["Settings"].tap()
        let row = app.staticTexts["Notifications"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no Notifications row")
        row.tap()
        let main = app.switches["Allow notifications"]
        XCTAssertTrue(main.waitForExistence(timeout: 5), "the Notifications page has no main switch")

        app.switches["A PR is ready to merge"].tap()
        for _ in 0..<10 where !read().contains("\"ready\"") { sleep(1) }
        XCTAssertTrue(read().contains("\"ready\""), "the server was not told Ready to merge is off")
        snap(app, "settings-kinds")
        app.switches["A PR is ready to merge"].tap()
        for _ in 0..<10 where read().contains("\"ready\"") { sleep(1) }
        XCTAssertFalse(read().contains("\"ready\""), "the server still skips Ready to merge")
        snap(app, "settings-on")

        main.tap()
        sleep(3)
        XCTAssertFalse(held(), "off left the handle on the server")
        snap(app, "settings-off")
        main.tap()
        for _ in 0..<20 where !held() { sleep(1) }
        XCTAssertTrue(held(), "on gave the server no handle")
    }

    /// `simctl push` never runs the service extension, so the fake APNs saves an
    /// alert that needs it (`FAKE_APNS_DRESS_DIR`) and the app, a DEBUG build, dresses
    /// that same payload as the extension would and shows it once the app is away.
    private func dressed(_ app: XCUIApplication, _ kind: String) throws {
        guard let dir = env["DRAY_DRESS"] else { throw XCTSkip("set TEST_RUNNER_DRAY_DRESS to FAKE_APNS_DRESS_DIR") }
        let file = "\(dir)/\(kind).json"
        for _ in 0..<180 where !FileManager.default.fileExists(atPath: file) { sleep(1) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: file), "the relay sent no \(kind) alert")
        // Through the system: `app.open` relaunches with the test's `-servers ""`, a phone with no servers.
        XCUIDevice.shared.system.open(URL(string: "dray://debug-push?file=\(file)")!)
        sleep(1)
        XCUIDevice.shared.press(.home)
    }

    /// The banner on screen matching `predicate`, waited on for as long as a turn may take.
    private func banner(_ predicate: String) -> XCUIElement {
        let match = springboard.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == 'NotificationShortLookView' AND (\(predicate))")).firstMatch
        XCTAssertTrue(match.waitForExistence(timeout: 180), "no banner where \(predicate)")
        return match
    }

    /// Launches on the test server and allows notifications when iOS asks.
    private func paired() throws -> XCUIApplication {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let relay = env["DRAY_RELAY"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN and TEST_RUNNER_DRAY_RELAY")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-pushRelay", relay]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()
        let allow = springboard.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 20), "iOS never asked to allow notifications")
        snap(springboard, "0-asked")
        allow.tap()
        sleep(3)
        return app
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
