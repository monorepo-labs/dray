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
        if keyboard {
            // Save draft lives in Run with, never over the field.
            XCTAssertFalse(app.buttons["Save draft"].exists, "Save draft still floats over the field")
            app.buttons["More picks"].tap()
            let save = app.buttons["Save draft"]
            XCTAssertTrue(save.waitForExistence(timeout: 5), "Run with offers no Save draft")
            snap(app, "run-with-save")
            save.tap()
            XCTAssertTrue(save.waitForNonExistence(timeout: 10), "saving left Run with open")
            XCTAssertFalse((input.value as? String ?? "").contains("dark mode"), "saving left the words in the field")
            snap(app, "saved")
            input.tap()
            input.typeText("Add a dark mode toggle")
        }

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

    /// The field's keyboard goes on a tap outside it and a swipe down below it, on the
    /// list and in a task's chat, and a tap inside keeps it (#1244).
    func testKeyboardCloses() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let task = env["DRAY_TASK"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, _TOKEN and _TASK")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test server")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10))
        app.buttons["Add"].tap()

        let input = app.descendants(matching: .any)["chatInput"]
        let keyboard = app.keyboards.firstMatch
        func open(_ words: String) {
            input.tap()
            XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "the field opened no keyboard")
            input.typeText(words)
            sleep(1)
        }
        func closed(_ how: String) {
            XCTAssertTrue(keyboard.waitForNonExistence(timeout: 3), "\(how) left the keyboard up")
            sleep(1)
        }
        func swipeBelow() {
            let start = input.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1)).withOffset(CGVector(dx: 0, dy: 24))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 160)))
        }
        func tapAbove() { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap() }

        XCTAssertTrue(input.waitForExistence(timeout: 20), "no text field on the list")
        sleep(1)
        snap(app, "one-line-empty")
        open("Add a dark mode toggle")
        snap(app, "one-line")
        input.tap()
        sleep(1)
        XCTAssertTrue(keyboard.exists, "a tap inside the field closed the keyboard")
        tapAbove()
        closed("a tap above the field")
        open(" now")
        swipeBelow()
        closed("a swipe below the field")

        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", task)).firstMatch.tap()
        sleep(3)
        open("Add a test for it")
        snap(app, "task-one-line")
        tapAbove()
        closed("a tap above the task's field")
        open(" too")
        swipeBelow()
        closed("a swipe below the task's field")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
