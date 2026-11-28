import XCTest

/// #1360 against a real server: a task's uncommitted diffs in several languages, its
/// reply's code blocks, and a bot chat's, each screenshotted for a look at the colours.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_TASK="<title>"
///   TEST_RUNNER_DRAY_FILES="a.ts,b.swift" TEST_RUNNER_DRAY_BOT="<bot name>"
///   xcodebuild test -only-testing:DrayUITests/CodeColourTests
final class CodeColourTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testCodeColours() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let task = env["DRAY_TASK"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, _TOKEN and _TASK")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()

        let row = labelled(app, task)
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no \(task)")
        row.tap()
        sleep(3)
        snap(app, "chat")
        let button = app.buttons["Changes"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "no Changes button")
        button.tap()
        for name in (env["DRAY_FILES"] ?? "").split(separator: ",").map(String.init) {
            let file = app.staticTexts[name]
            XCTAssertTrue(file.waitForExistence(timeout: 20), "no \(name)")
            file.tap()
            sleep(2)
            snap(app, "diff-\(name)")
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        if let bot = env["DRAY_BOT"] {
            app.navigationBars.buttons.element(boundBy: 0).tap()
            app.navigationBars.buttons.element(boundBy: 0).tap()
            let botRow = labelled(app, bot)
            XCTAssertTrue(botRow.waitForExistence(timeout: 20), "no bot \(bot)")
            botRow.tap()
            sleep(4)
            snap(app, "bot-chat")
        }
    }

    private func labelled(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
