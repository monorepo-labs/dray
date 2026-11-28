import XCTest

/// A routine opened from the bot's Tasks sheet (#1637), against a real server holding a
/// bot with two routines, "Scratch watch" and "Scratch gone": the switch still flips
/// without opening it, both fields edit and save, an edit survives a list read, the
/// details go back when the routine is deleted, and Delete still works from the row.
/// The host changes the routines when the test asks, by a file in `DRAY_SIGNAL`:
/// `pause` pauses Scratch watch, `gone` deletes Scratch gone. `DRAY_OLD=1` is a server
/// from before `update_routine`, where Save must fail and keep the edit.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=… TEST_RUNNER_DRAY_SIGNAL=/tmp/… xcodebuild test …
final class RoutineDetailsTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testOpenEditSave() throws {
        guard let name = env["DRAY_BOT"], let signal = env["DRAY_SIGNAL"] else { throw XCTSkip("set TEST_RUNNER_DRAY_BOT and _SIGNAL") }
        let old = env["DRAY_OLD"] == "1"
        let app = try connected()
        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 20), "no bot row")
        bot.tap()
        XCTAssertTrue(app.buttons["Tasks"].waitForExistence(timeout: 10))
        app.buttons["Tasks"].tap()
        let open = app.buttons["Open Scratch watch"]
        XCTAssertTrue(open.waitForExistence(timeout: 10), "no routine row")
        let save = app.buttons["Save changes"]

        // The switch flips and opens nothing.
        app.switches["Turn off Scratch watch"].tap()
        XCTAssertTrue(app.switches["Turn on Scratch watch"].waitForExistence(timeout: 5), "did not turn off")
        XCTAssertFalse(save.exists, "the switch opened the routine")
        app.switches["Turn on Scratch watch"].tap()
        XCTAssertTrue(app.switches["Turn off Scratch watch"].waitForExistence(timeout: 5), "did not turn back on")
        snap(app, "list")

        open.tap()
        XCTAssertTrue(save.waitForExistence(timeout: 5), "the routine did not open")
        XCTAssertFalse(save.isEnabled, "Save is on with nothing changed")
        XCTAssertFalse(app.buttons["Discard"].exists, "Discard shows with nothing changed")
        // A fresh install asks for notifications about now, and the alert eats keystrokes.
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        snap(app, "details")

        let field = app.textFields["Name"]
        field.tap()
        field.typeText(" 2")
        let instructions = app.textViews["Instructions"]
        // Past the end of the one line of text, so the caret lands after it.
        instructions.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.12)).tap()
        sleep(1)
        instructions.typeText(" Also check CI.")
        XCTAssertEqual(instructions.value as? String, "Check the scratch folder for new files. Also check CI.")
        XCTAssertTrue(app.buttons["Discard"].exists, "no Discard after an edit")
        XCTAssertTrue(save.isEnabled, "Save is off after an edit")

        // A list read while editing: the schedule moves, the edit stays.
        try "pause".write(toFile: "\(signal)/pause", atomically: true, encoding: .utf8)
        let paused = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Paused'")).firstMatch
        XCTAssertTrue(paused.waitForExistence(timeout: 30), "the paused routine never showed through")
        XCTAssertEqual(field.value as? String, "Scratch watch 2", "the name edit was lost on a list read")
        snap(app, "edited")

        save.tap()
        if old {
            let error = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH \"Couldn't save it\"")).firstMatch
            XCTAssertTrue(error.waitForExistence(timeout: 10), "no save error from an old server")
            XCTAssertEqual(field.value as? String, "Scratch watch 2", "a failed save dropped the edit")
            XCTAssertTrue(save.isEnabled)
            snap(app, "save-failed")
            app.buttons["Discard"].tap()
            XCTAssertEqual(field.value as? String, "Scratch watch", "Discard did not put the name back")
        } else {
            XCTAssertTrue(app.navigationBars["Scratch watch 2"].waitForExistence(timeout: 10), "the save did not land")
            XCTAssertFalse(save.isEnabled, "Save still on after saving")
            XCTAssertFalse(app.buttons["Discard"].exists, "Discard still shows after saving")
            snap(app, "saved")
        }
        let renamed = old ? "Scratch watch" : "Scratch watch 2"
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["Open \(renamed)"].waitForExistence(timeout: 5), "back did not return to the list")

        // A routine deleted while open goes back to the list.
        app.buttons["Open Scratch gone"].tap()
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        try "gone".write(toFile: "\(signal)/gone", atomically: true, encoding: .utf8)
        let back = NSPredicate(format: "exists == false")
        expectation(for: back, evaluatedWith: save)
        waitForExpectations(timeout: 30)
        XCTAssertTrue(app.buttons["Open \(renamed)"].waitForExistence(timeout: 5), "not back on the list")

        // Delete from the long-press menu, as before.
        app.buttons["Open \(renamed)"].press(forDuration: 1.2)
        let delete = app.buttons["Delete routine"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "no Delete in the long-press menu")
        delete.tap()
        expectation(for: back, evaluatedWith: app.buttons["Open \(renamed)"])
        waitForExpectations(timeout: 10)
        snap(app, "deleted")
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
