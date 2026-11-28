import XCTest

/// A routine's report to its bot draws nothing in the bot's chat, idle or queued mid-turn,
/// while the bot's reply to it does. Against a real server holding such a chat:
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=<name>
///   TEST_RUNNER_DRAY_REPORT=<text only a report holds> TEST_RUNNER_DRAY_REPLY=<text of the bot's reply>
final class RoutineReportTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testRoutineReportsStayHidden() throws {
        guard let name = env["DRAY_BOT"], let report = env["DRAY_REPORT"], let reply = env["DRAY_REPLY"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_BOT, TEST_RUNNER_DRAY_REPORT and TEST_RUNNER_DRAY_REPLY")
        }
        let app = try connected()
        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 20), "no bot row")
        bot.tap()
        let leaked = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@ OR label CONTAINS %@", report, "message from the Dray routine"))
        // Newest first: each reply is scrolled to, and no report may sit anywhere on the way.
        for (i, text) in reply.split(separator: "|").map(String.init).enumerated() {
            let said = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
            _ = said.waitForExistence(timeout: i == 0 ? 15 : 2)
            for _ in 0..<8 where !(said.exists && said.isHittable) {
                app.scrollViews.firstMatch.swipeDown()
                sleep(1)
            }
            XCTAssertTrue(said.exists, "the bot's reply \(text) did not draw")
            sleep(1)
            snap(app, "bot-chat-\(i)")
            XCTAssertEqual(leaked.count, 0, "a routine's report drew in the chat")
        }
    }

    private func connected() throws -> XCUIApplication {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()
        return app
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
