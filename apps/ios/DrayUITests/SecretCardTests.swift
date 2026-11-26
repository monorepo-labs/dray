import XCTest

/// The secret card and Settings › Vault (#1605), against a real server with real
/// agents. Each test wants tasks the script before it started: `sec-new.sh NAME TITLE`
/// runs `dray session new` asking for NAME and waits for its card.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_SECRET=<throwaway value>
///
/// 1. `testPasteAndSave` — "Secret A" asks for DEMO_API_KEY: Vault gets OTHER_TOKEN, the card is pasted into with Save to Vault on.
/// 2. `testUseSavedAndDecline` — "Secret B" asks for DEMO_API_KEY again, "Secret C" for NOPE_KEY: Use saved, then Decline.
final class SecretCardTests: XCTestCase {
    private var app: XCUIApplication!
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func pair() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-list.hideSessions", "NO"]
        app.launch()
        XCTAssertTrue(app.buttons["Enter an address"].waitForExistence(timeout: 10), "no empty list")
        app.buttons["Enter an address"].tap()
        for (field, text) in [("Address", url), ("Token", token), ("Name", "Scratch")] {
            XCTAssertTrue(app.textFields[field].waitForExistence(timeout: 5), "no \(field) field")
            app.textFields[field].tap()
            app.textFields[field].typeText(text)
        }
        app.buttons["Add"].tap()
    }

    private func open(_ title: String) {
        let row = app.staticTexts[title].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no row \(title)")
        row.tap()
    }

    private func element(_ label: String) -> XCUIElement { app.descendants(matching: .any)[label].firstMatch }

    private func waitFor(_ predicate: String, _ arg: String, timeout: TimeInterval) -> Bool {
        app.staticTexts.matching(NSPredicate(format: predicate, arg)).firstMatch.waitForExistence(timeout: timeout)
    }

    func testPasteAndSave() throws {
        try pair()
        guard let value = env["DRAY_SECRET"] else { throw XCTSkip("no value") }
        XCTAssertTrue(app.staticTexts["Secret A"].waitForExistence(timeout: 20), "no task row")
        sleep(1)
        attach("list")

        // Vault: add a second secret, so the next card offers a picker.
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.buttons["Vault"].waitForExistence(timeout: 5), "no Vault row")
        app.buttons["Vault"].tap()
        XCTAssertTrue(waitFor("label == %@", "None saved yet.", timeout: 10), "no empty Vault")
        attach("vault-empty")
        app.buttons["Add secret"].tap()
        let name = app.textFields["Name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5), "no Name field")
        name.typeText("OTHER_TOKEN")
        app.secureTextFields["Value"].tap()
        app.secureTextFields["Value"].typeText("other-throwaway-123")
        attach("vault-add")
        app.navigationBars.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["OTHER_TOKEN"].waitForExistence(timeout: 10), "OTHER_TOKEN not listed")
        sleep(1)
        attach("vault-list")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["Done"].tap()

        open("Secret A")
        let field = app.secureTextFields["DEMO_API_KEY"]
        XCTAssertTrue(field.waitForExistence(timeout: 15), "no secret card")
        sleep(1)
        attach("card")
        field.tap()
        field.typeText(value)
        element("Save to Vault").tap()
        sleep(1)
        attach("card-filled")
        app.buttons["Share"].tap()
        XCTAssertTrue(waitFor("label CONTAINS %@", "on this machine", timeout: 15), "no Saved line")
        // The agent reads the file and reports the digest.
        _ = waitFor("label CONTAINS[c] %@", env["DRAY_DIGEST"] ?? "-", timeout: 120)
        sleep(2)
        attach("answered")
    }

    func testUseSavedAndDecline() throws {
        try pair()
        open("Secret B")
        let use = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Use saved")).firstMatch
        XCTAssertTrue(use.waitForExistence(timeout: 15), "no Use saved")
        sleep(1)
        attach("saved")
        app.buttons["Pick another saved secret"].tap()
        sleep(1)
        attach("saved-picker")
        app.buttons["DEMO_API_KEY"].firstMatch.tap()
        app.buttons["Paste a new one"].tap()
        sleep(1)
        attach("saved-paste-new")
        app.buttons["Use saved"].tap()
        XCTAssertTrue(use.waitForExistence(timeout: 5), "back did not return to Use saved")
        use.tap()
        XCTAssertTrue(waitFor("label CONTAINS %@", "Used saved", timeout: 15), "no Used saved line")
        _ = waitFor("label CONTAINS[c] %@", env["DRAY_DIGEST"] ?? "-", timeout: 120)
        sleep(2)
        attach("used")

        app.navigationBars.buttons.element(boundBy: 0).tap()
        open("Secret C")
        XCTAssertTrue(app.secureTextFields["NOPE_KEY"].waitForExistence(timeout: 15), "no card C")
        app.buttons["Decline"].tap()
        XCTAssertTrue(waitFor("label CONTAINS %@", "Declined", timeout: 15), "no Declined line")
        sleep(20)
        attach("declined")
    }

    /// 3. After both: each answered task, read cold from its log, leads its answer's turn with the line.
    func testLinesReadBack() throws {
        try pair()
        for title in ["Secret A", "Secret B", "Secret C"] {
            open(title)
            XCTAssertTrue(waitFor("label CONTAINS %@", "_KEY", timeout: 15), "no line in \(title)")
            sleep(2)
            attach(title)
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
    }

    /// 4. The ⌄ picker is a sheet, with search past `secretSearchAfter` saved. A task asking for
    /// DEMO_API_KEY titled `TEST_RUNNER_DRAY_TITLE`, with `TEST_RUNNER_DRAY_SAVED` secrets saved.
    func testPickerSheet() throws {
        try pair()
        let saved = Int(env["DRAY_SAVED"] ?? "2") ?? 2
        open(env["DRAY_TITLE"] ?? "Secret D")
        let use = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Use saved")).firstMatch
        XCTAssertTrue(use.waitForExistence(timeout: 15), "no Use saved")
        app.buttons["Pick another saved secret"].tap()
        XCTAssertTrue(app.navigationBars["Saved secrets"].waitForExistence(timeout: 5), "no sheet")
        sleep(1)
        attach("\(saved)-sheet")
        let search = app.searchFields.firstMatch
        if saved > 6 {
            XCTAssertTrue(search.exists, "no search with \(saved) saved")
            search.tap()
            search.typeText("TOK")
            sleep(1)
            attach("\(saved)-search")
        } else {
            XCTAssertFalse(search.exists, "search with only \(saved) saved")
        }
        app.buttons["OTHER_TOKEN"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "OTHER_TOKEN")).firstMatch.waitForExistence(timeout: 5),
                      "the pick did not reach Use saved")
        sleep(1)
        attach("\(saved)-picked")
        // Back to the one asked for, and use it, so the card closes for the next run.
        app.buttons["Pick another saved secret"].tap()
        XCTAssertTrue(app.buttons["DEMO_API_KEY"].waitForExistence(timeout: 5))
        app.buttons["DEMO_API_KEY"].tap()
        use.tap()
        XCTAssertTrue(waitFor("label CONTAINS %@", "Used saved", timeout: 15), "no Used saved line")
    }

    private func attach(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
