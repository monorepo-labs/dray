import XCTest

/// A server that can't transcribe draws a text field where the orb goes, on the
/// list, a bot's chat and a task's chat; one that can keeps the orb. Run against
/// a `dray-serve` whose `gh` is logged out (an empty `GH_CONFIG_DIR`), the same
/// pass checks the PR notice stays off a task with no GitHub remote and on one with.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=Ops \
///   TEST_RUNNER_DRAY_TASK="Fix login redirect" TEST_RUNNER_DRAY_GH_TASK="Bump deps" \
///   TEST_RUNNER_DRAY_EXPECT=keyboard|orb xcodebuild test …
final class KeyboardModeTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testDockFollowsTranscription() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let bot = env["DRAY_BOT"], let task = env["DRAY_TASK"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, _TOKEN, _BOT and _TASK")
        }
        let keyboard = env["DRAY_EXPECT"] != "orb"
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test server")]
        app.open(link.url!)
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()

        let input = app.descendants(matching: .any)["chatInput"]
        let orb = app.descendants(matching: .any)["orb"]
        func check(_ screen: String, type words: String) {
            if keyboard {
                XCTAssertTrue(input.waitForExistence(timeout: 15), "no text field on \(screen)")
                XCTAssertFalse(orb.exists, "the orb still shows on \(screen)")
                input.tap()
                input.typeText(words)
                sleep(1)
                XCTAssertTrue(input.isHittable, "the keyboard covers the field on \(screen)")
            } else {
                XCTAssertTrue(orb.waitForExistence(timeout: 15), "no orb on \(screen)")
                XCTAssertFalse(input.exists, "a text field shows on \(screen)")
            }
            snap(app, screen)
        }
        func row(_ label: String) -> XCUIElement {
            app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
        }
        func back() {
            app.navigationBars.buttons.element(boundBy: 0).tap()
            sleep(1)
        }

        XCTAssertTrue(row(bot).waitForExistence(timeout: 20), "no bot row")
        sleep(1)
        check("list", type: "Add a dark mode toggle")
        if keyboard { XCTAssertTrue(app.buttons["Save draft"].exists, "typing a task offers no Save draft") }

        // More models opens the shortlist: a toggle per model, and one switched on joins the chips.
        app.buttons["Model"].firstMatch.tap()
        let more = app.buttons["More models"]
        XCTAssertTrue(more.waitForExistence(timeout: 10), "no More models chip")
        snap(app, "models-chips")
        more.tap()
        let off = app.descendants(matching: .any).matching(NSPredicate(format: "value == 'Off'")).firstMatch
        XCTAssertTrue(off.waitForExistence(timeout: 5), "the Models sheet has no switched-off model")
        snap(app, "models-sheet")
        let name = off.label
        off.tap()
        sleep(1)
        snap(app, "models-sheet-on")
        app.buttons["Done"].firstMatch.tap()
        sleep(1)
        XCTAssertTrue(app.buttons[name].exists, "\(name) never joined the chips")
        snap(app, "models-chips-after")
        app.swipeDown(velocity: .fast)
        sleep(1)

        row(bot).tap()
        sleep(2)
        check("bot-chat", type: "What broke overnight?")
        back()

        row(task).tap()
        sleep(4)
        check("task-chat", type: "Add a test for it")
        XCTAssertFalse(app.buttons["Pull request"].exists, "a task with no GitHub remote shows the PR button")

        if let gh = env["DRAY_GH_TASK"], !gh.isEmpty {
            back()
            row(gh).tap()
            XCTAssertTrue(app.buttons["Pull request"].waitForExistence(timeout: 15), "a GitHub task lost its logged-out notice")
            app.buttons["Pull request"].tap()
            sleep(2)
            snap(app, "gh-logged-out")
        }
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
