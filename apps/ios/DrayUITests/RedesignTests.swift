import XCTest

/// The #825 screens against a real server: pairs through a `dray://connect`
/// link, then walks the list, a session and the empty states, attaching a
/// screenshot of each. Export them with `xcrun xcresulttool export attachments`.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… xcodebuild test …
final class RedesignTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testScreens() throws {
        let app = try pair()
        let row = labelled(app, "Check the Xcode version")
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no session listed")
        sleep(3)
        snap(app, "list")
        app.buttons["Drafts"].tap()
        XCTAssertTrue(labelled(app, "Add retry with backoff to the upload client").waitForExistence(timeout: 10), "no draft listed")
        snap(app, "list-drafts")
        app.buttons["Settled"].tap()
        XCTAssertTrue(labelled(app, "Port tools.ts labels to Swift").waitForExistence(timeout: 10), "no settled session listed")
        snap(app, "list-settled")
        app.buttons["Settled"].tap()
        app.buttons["thinking-orbs"].tap()
        sleep(1)
        snap(app, "list-project")
        labelled(app, "Fix flaky reconnect test").tap()
        sleep(3)
        snap(app, "session")
    }

    /// Answers both inline cards from the list. Spends the seeded asks, so run it last.
    func testAnswerInline() throws {
        let app = try pair()
        let allow = app.buttons["Allow once"]
        XCTAssertTrue(allow.waitForExistence(timeout: 20), "no permission card in the list")
        sleep(2)
        allow.tap()
        XCTAssertTrue(allow.waitForNonExistence(timeout: 15), "the permission card stayed")
        sleep(1)
        labelled(app, "iPhone SE").tap()
        app.buttons["Next"].tap()
        XCTAssertTrue(labelled(app, "Should I post screenshots on the PR?").waitForExistence(timeout: 5))
        sleep(1)
        labelled(app, "Yes").tap()
        app.buttons["Send"].tap()
        XCTAssertTrue(app.buttons["Send"].waitForNonExistence(timeout: 15), "the question card stayed")
        sleep(3)
        snap(app, "answered")
    }

    /// A new task by voice: tap for the hint, hold to record, cancel and keep,
    /// stop, edit the words, then start it. Wants the microphone granted and
    /// something saying words near the Mac's microphone while it runs.
    func testVoiceTask() throws {
        let app = try pair()
        let orb = app.descendants(matching: .any)["orb"]
        XCTAssertTrue(orb.waitForExistence(timeout: 20), "no voice dock")
        sleep(2)
        snap(app, "voice-rest")
        // Not asserted: the hint lasts two seconds, and a loaded simulator's query can miss it.
        orb.tap()
        _ = app.staticTexts["Hold to talk"].waitForExistence(timeout: 2)
        snap(app, "voice-hint")
        sleep(2)
        orb.press(forDuration: 0.6)
        let stop = app.buttons["Done"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "holding the orb started no recording")
        sleep(3)
        snap(app, "voice-recording")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.staticTexts["Discard this recording?"].waitForExistence(timeout: 3))
        snap(app, "voice-recording-confirm")
        app.buttons["Keep recording"].tap()
        sleep(4)
        stop.tap()
        snap(app, "voice-transcribing")
        // Words need a microphone that hears something; a muted Mac gives the
        // simulator silence, and the dock then says so instead.
        let start = app.buttons["Start task"]
        // A query, not the element: an element that goes between two reads throws.
        let heard = app.buttons.matching(NSPredicate(format: "label == 'Start task' AND isEnabled == true"))
        let silent = app.staticTexts["No words heard."]
        for _ in 0..<90 where heard.count == 0 && !silent.exists { sleep(1) }
        let spoke = !silent.exists
        XCTAssertTrue(spoke || silent.exists, "transcription never answered")
        sleep(1)
        snap(app, spoke ? "voice-ready" : "voice-no-words")
        if spoke {
            app.buttons["Cancel"].tap()
            XCTAssertTrue(app.staticTexts["Discard this task?"].waitForExistence(timeout: 3))
            snap(app, "voice-ready-confirm")
            app.buttons["Keep"].tap()
            sleep(1)
        }
        app.buttons["Keyboard"].tap()
        let editor = app.textViews[spoke ? "Edit task" : "New task"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5), "the keyboard opened no sheet")
        editor.typeText(spoke ? " Reply with the single word: done." : "Reply with the single word: done.")
        snap(app, "voice-edit")
        app.buttons["Done"].tap()
        sleep(1)
        if !spoke {
            snap(app, "voice-ready")
            app.buttons["Cancel"].tap()
            XCTAssertTrue(app.staticTexts["Discard this task?"].waitForExistence(timeout: 3))
            snap(app, "voice-ready-confirm")
            app.buttons["Keep"].tap()
            sleep(1)
        }
        start.tap()
        // The started task opens, and the dock stays on the list behind it.
        XCTAssertTrue(orb.waitForNonExistence(timeout: 60), "the task never started")
        sleep(4)
        snap(app, "voice-started")
    }

    /// Typing a task from scratch, then saving it as a draft from Cancel.
    func testTypeAndSaveDraft() throws {
        let app = try pair()
        let keyboard = app.buttons["Keyboard"]
        XCTAssertTrue(keyboard.waitForExistence(timeout: 20))
        sleep(2)
        keyboard.tap()
        let editor = app.textViews["New task"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.typeText("Add retry with backoff to the upload client")
        snap(app, "type-new")
        app.buttons["Done"].tap()
        app.buttons["Cancel"].tap()
        snap(app, "type-confirm")
        app.buttons["Save draft"].tap()
        XCTAssertTrue(app.buttons["Start task"].waitForNonExistence(timeout: 10), "saving left the dock open")
        app.buttons["Drafts"].tap()
        sleep(2)
        snap(app, "type-drafts")
    }

    /// Anything on screen by its label: a row's title is read off its button, not a static text.
    func labelled(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    func testEmpty() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        sleep(2)
        snap(app, "empty-connect")
    }

    /// A fresh launch with no saved server, paired through the link a QR carries.
    func pair() throws -> XCUIApplication {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Studio Mac")]
        app.open(link.url!)
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()
        return app
    }

    func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
