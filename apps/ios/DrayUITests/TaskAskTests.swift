import XCTest

/// A bot's hidden task stopped on a question draws its card in the bot's chat,
/// and answering it there unblocks the task. Against a real server holding a
/// bot (`DRAY_BOT`) whose hidden task, here or on another machine this one shares,
/// asks `DRAY_QUESTION` (default "Which colour?") with `DRAY_PICK` (default Red) among its options:
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=… xcodebuild test …
final class TaskAskTests: XCTestCase {
    func testTaskQuestionInBotChat() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let name = env["DRAY_BOT"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN and TEST_RUNNER_DRAY_BOT")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "This Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()

        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 30), "no bot row")
        sleep(2)
        snap(app, "1-list")
        bot.tap()

        let question = app.staticTexts[env["DRAY_QUESTION"] ?? "Which colour?"]
        XCTAssertTrue(question.waitForExistence(timeout: 20), "the task's question did not reach the bot's chat")
        sleep(1)
        snap(app, "2-card")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", env["DRAY_PICK"] ?? "Red")).firstMatch.tap()
        app.buttons["Send"].tap()

        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: question)
        waitForExpectations(timeout: 20)
        sleep(1)
        snap(app, "3-answered")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
