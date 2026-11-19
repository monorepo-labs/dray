import XCTest

/// A remote task opens on a thin first frame: a tool row opened reads its own call's whole
/// output, and "Load earlier" reads the page above. A bot chat opens on what it draws.
/// Against a real server holding both, the values naming what to tap and what must appear:
///   TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN,
///   TEST_RUNNER_DRAY_SERVERS (optional: a saved server list as a plist data literal, whose
///   token sits in the keychain already; else the connect link pairs),
///   TEST_RUNNER_DRAY_TASK (the task's title), TEST_RUNNER_DRAY_CALL (a call in its newest
///   turn), TEST_RUNNER_DRAY_OUTPUT (text of that call's output past the server's cut),
///   TEST_RUNNER_DRAY_EARLIER (a prompt above the first frame),
///   TEST_RUNNER_DRAY_BOT (a bot's name), TEST_RUNNER_DRAY_REPLY (a reply in its chat)
final class OnDemandReadTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testRowsAndPagesReadOnDemand() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let task = env["DRAY_TASK"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN and TEST_RUNNER_DRAY_TASK")
        }
        let app = XCUIApplication()
        if let saved = env["DRAY_SERVERS"] {
            app.launchArguments = ["-servers", saved]
            app.launch()
        } else {
            app.launchArguments = ["-servers", ""]
            app.launch()
            var link = URLComponents(string: "dray://connect")!
            link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
            app.open(link.url!)
            let add = app.buttons["Add"]
            XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
            add.tap()
        }

        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", task)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no task row")
        row.tap()
        let fold = app.buttons.matching(NSPredicate(format: "label CONTAINS 'tool call'")).firstMatch
        XCTAssertTrue(fold.waitForExistence(timeout: 30), "the newest turn never drew")
        sleep(2)
        snap(app, "task-opened")

        // The newest turn's call, cut in the first frame: opened, it reads its own body.
        fold.tap()
        sleep(1)
        tap(app, env["DRAY_CALL"]!)
        let output = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", env["DRAY_OUTPUT"]!)).firstMatch
        XCTAssertTrue(output.waitForExistence(timeout: 20), "the opened row never showed its whole output")
        snap(app, "row-opened")

        // Nothing above is read until asked.
        let older = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", env["DRAY_EARLIER"]!)).firstMatch
        XCTAssertFalse(older.exists, "the page above was read unasked")
        let earlier = app.buttons["Load earlier"]
        for _ in 0..<12 where !earlier.isHittable { app.swipeDown() }
        XCTAssertTrue(earlier.isHittable, "no Load earlier")
        earlier.tap()
        XCTAssertTrue(older.waitForExistence(timeout: 30), "the page above never landed")
        sleep(1)
        snap(app, "earlier-loaded")

        guard let bot = env["DRAY_BOT"], let reply = env["DRAY_REPLY"] else { return }
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let botRow = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", bot)).firstMatch
        XCTAssertTrue(botRow.waitForExistence(timeout: 10), "no bot row")
        botRow.tap()
        let said = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", reply)).firstMatch
        XCTAssertTrue(said.waitForExistence(timeout: 30), "the bot chat never drew its reply")
        sleep(2)
        snap(app, "bot-chat")
        // A bot's older pages are read as the chat draws them too.
        for _ in 0..<12 where !earlier.isHittable { app.swipeDown() }
        XCTAssertTrue(earlier.isHittable, "no Load earlier in the bot chat")
        let before = app.staticTexts.count
        earlier.tap()
        let grew = expectation(for: NSPredicate(format: "count > %d", before), evaluatedWith: app.staticTexts)
        wait(for: [grew], timeout: 30)
        sleep(1)
        snap(app, "bot-chat-earlier")
    }

    private func tap(_ app: XCUIApplication, _ label: String) {
        let all = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", label))
        let button = all.element(boundBy: max(all.count - 1, 0))
        XCTAssertTrue(button.waitForExistence(timeout: 10), "no row \(label)")
        for _ in 0..<6 where !button.isHittable { app.swipeUp() }
        button.tap()
        sleep(1)
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
