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
        let spoke = heard.count > 0
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
        // The started task opens.
        // The list dock's Project pick, which the session's dock has none of: the orb is in both.
        XCTAssertTrue(app.buttons["Project"].waitForNonExistence(timeout: 60), "the task never started")
        sleep(4)
        snap(app, "voice-started")
    }

    /// Typing a task from scratch, then saving it as a draft from Cancel.
    /// A session's foot: hold to reply, the reply as a bubble, the sheet, Send, and Stop while it runs.
    /// Opens a session from the list, scrolled clear of the dock first.
    func openRow(_ app: XCUIApplication, _ title: String) {
        // Below the two cards, so off screen at first: the list is lazy and only draws what scrolls in.
        let orb = app.descendants(matching: .any)["orb"]
        XCTAssertTrue(orb.waitForExistence(timeout: 20))
        let row = labelled(app, title)
        // The dock floats over the list, so a row behind it still reads as hittable and the tap lands on the orb.
        let clear = { row.exists && row.isHittable && row.frame.maxY < orb.frame.minY - 40 }
        for _ in 0..<8 where !clear() { app.swipeUp() }
        if !clear() { app.swipeDown(velocity: .slow) }
        XCTAssertTrue(clear(), "no row to open")
        row.tap()
        // The list's dock has a Project pick and the session's has none; both have the orb.
        XCTAssertTrue(app.buttons["Project"].waitForNonExistence(timeout: 20), "the session never opened")
        XCTAssertTrue(orb.waitForExistence(timeout: 20), "no dock in the session")
    }

    /// A server going bad under an open session, then the list: reconnecting, can't reach,
    /// needs an update, token refused. Wants `/tmp/dray825-proxy.py` in front of the server:
    ///   TEST_RUNNER_DRAY_PROXY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_PROXY_MODE=/tmp/…
    func testConnectionBanners() throws {
        guard let proxy = env["DRAY_PROXY_URL"], let modeFile = env["DRAY_PROXY_MODE"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_PROXY_URL and TEST_RUNNER_DRAY_PROXY_MODE")
        }
        let mode = { (m: String) in try? m.write(toFile: modeFile, atomically: true, encoding: .utf8) }
        mode("forward")
        defer { mode("forward") }
        let app = try pair(url: proxy)
        openRow(app, "Tighten session row spacing")
        sleep(2)
        snap(app, "conn-session-ok")

        mode("hang")
        XCTAssertTrue(app.staticTexts["Reconnecting to Studio Mac…"].waitForExistence(timeout: 30), "no reconnecting banner")
        sleep(1)
        snap(app, "conn-session-reconnecting")

        mode("down")
        let unreachable = app.staticTexts["Can't reach Studio Mac"]
        XCTAssertTrue(unreachable.waitForExistence(timeout: 60), "no can't-reach banner")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Trying again'")).firstMatch.exists)
        snap(app, "conn-session-unreachable")
        // At the top, the first row sits clear of the banner rather than under it.
        for _ in 0..<6 { app.swipeDown(velocity: .fast) }
        snap(app, "conn-session-top")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        // The banner heads the list, and opening the row left it scrolled down.
        for _ in 0..<5 where !unreachable.waitForExistence(timeout: 2) { app.swipeDown() }
        XCTAssertTrue(unreachable.exists, "the list says nothing of the server")
        sleep(1)
        snap(app, "conn-list-unreachable")

        mode("older")
        app.buttons["Retry"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Studio Mac needs an update"].waitForExistence(timeout: 30), "no needs-update banner")
        openRow(app, "Tighten session row spacing")
        sleep(1)
        snap(app, "conn-session-older")

        mode("token")
        app.buttons["Retry"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Studio Mac refused the token"].waitForExistence(timeout: 30), "no token banner")
        sleep(1)
        snap(app, "conn-session-token")
        app.buttons["Fix"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Paste a new token"].waitForExistence(timeout: 10)
            || app.textFields["Token"].waitForExistence(timeout: 1), "Fix opened no settings")
    }

    /// No network: the session says its task keeps running, the list says it once for all.
    func testOfflineBanners() throws {
        let app = try pair(offline: true)
        openRow(app, "Tighten session row spacing")
        XCTAssertTrue(app.staticTexts["The task keeps running on Studio Mac."].waitForExistence(timeout: 10))
        sleep(1)
        snap(app, "conn-session-offline")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let offline = app.staticTexts["Tasks keep running on their servers."]
        for _ in 0..<5 where !offline.waitForExistence(timeout: 2) { app.swipeDown() }
        XCTAssertTrue(offline.exists, "the list says nothing of being offline")
        sleep(1)
        snap(app, "conn-list-offline")
    }

    func testReplyDock() throws {
        let app = try pair()
        openRow(app, "Tighten session row spacing")
        let orb = app.descendants(matching: .any)["orb"]
        sleep(3)
        snap(app, "reply-rest")

        orb.press(forDuration: 0.6)
        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10), "holding the orb started no recording")
        sleep(2)
        snap(app, "reply-recording")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.staticTexts["Discard this recording?"].waitForExistence(timeout: 3))
        app.buttons["Keep recording"].tap()
        done.tap()
        snap(app, "reply-transcribing")
        let heard = app.buttons.matching(NSPredicate(format: "label == 'Send' AND isEnabled == true"))
        let silent = app.staticTexts["No words heard."]
        for _ in 0..<90 where heard.count == 0 && !silent.exists { sleep(1) }
        let spoke = heard.count > 0
        XCTAssertTrue(spoke || silent.exists, "transcription never answered")

        app.buttons["Keyboard"].tap()
        let editor = app.textViews[spoke ? "Edit message" : "Reply"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5), "the keyboard opened no sheet")
        editor.typeText("Run `sleep 20` in the shell, then reply with the single word SLEPT.")
        snap(app, "reply-sheet")
        app.buttons["Done"].tap()
        sleep(1)
        snap(app, "reply-ready")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.staticTexts["Discard this reply?"].waitForExistence(timeout: 3))
        snap(app, "reply-confirm")
        app.buttons["Keep"].tap()
        app.buttons["Keyboard"].tap()
        XCTAssertTrue(app.textViews["Edit message"].waitForExistence(timeout: 5), "the sheet lost its title")
        snap(app, "reply-edit")
        app.buttons["Done"].tap()
        sleep(1)
        app.buttons["Send"].tap()

        let stop = app.buttons["Stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 60), "no Stop while the turn runs")
        sleep(2)
        snap(app, "reply-running")
        app.buttons["Model"].tap()
        XCTAssertTrue(app.staticTexts["This task"].waitForExistence(timeout: 5), "the model pick opened no sheet")
        sleep(1)
        snap(app, "reply-this-task")
        app.buttons["Done"].tap()
        XCTAssertTrue(stop.waitForNonExistence(timeout: 180), "the turn never ended")
        sleep(2)
        snap(app, "reply-answered")
    }

    /// Run with from the list's dock: a star, the project menu, and a branch switch over uncommitted
    /// files. Wants `thinking-orbs` on the server holding a `fix-reconnect` branch and dirty files.
    func testRunWithSheet() throws {
        let app = try pair()
        let model = app.buttons["Model"]
        XCTAssertTrue(model.waitForExistence(timeout: 20))
        sleep(2)
        snap(app, "picks-dock")
        model.tap()
        XCTAssertTrue(app.staticTexts["Run with"].waitForExistence(timeout: 5), "the model pick opened no sheet")
        let haiku = app.buttons["Haiku 5.5"]
        XCTAssertTrue(haiku.waitForExistence(timeout: 15), "no model chips")
        sleep(1)
        snap(app, "picks-run-with")

        haiku.doubleTap()
        XCTAssertEqual(haiku.value as? String, "Starred", "a double-tap starred nothing")
        sleep(1)
        snap(app, "picks-starred")
        haiku.doubleTap()
        XCTAssertNotEqual(haiku.value as? String, "Starred", "a second double-tap left the star")

        app.buttons["row.Project"].tap()
        let orbs = menuItem(app, "thinking-orbs")
        XCTAssertTrue(orbs.exists, "no thinking-orbs in the project menu")
        XCTAssertTrue(app.buttons["Attach project…"].exists, "no Attach inside the project menu")
        snap(app, "picks-project-menu")
        orbs.tap()

        let worktree = app.switches["Worktree"]
        if worktree.value as? String == "On" { worktree.tap() }
        let branch = app.buttons["row.Branch"]
        XCTAssertTrue(branch.waitForExistence(timeout: 10), "worktree off shows no branch row")
        snap(app, "picks-branch")
        branch.tap()
        menuItem(app, "fix-reconnect").tap()
        let bring = app.buttons["Bring changes"]
        XCTAssertTrue(bring.waitForExistence(timeout: 5), "uncommitted files asked nothing")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'uncommitted files'")).count > 0)
        snap(app, "picks-dirty")
        bring.tap()
        XCTAssertTrue(app.staticTexts["fix-reconnect"].waitForExistence(timeout: 15), "the checkout never landed")
        snap(app, "picks-switched")
        // Back as it was, for the next run.
        branch.tap()
        menuItem(app, "main").tap()
        app.buttons["Bring changes"].tap()
        XCTAssertTrue(app.staticTexts["main"].waitForExistence(timeout: 15))
        worktree.tap()
        app.buttons["Done"].tap()
        XCTAssertTrue(app.staticTexts["Run with"].waitForNonExistence(timeout: 5))
    }

    /// An open menu's item: the last of its name, since the list under the sheet can hold the same one.
    private func menuItem(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        let all = app.buttons.matching(NSPredicate(format: "label == %@", label))
        _ = all.firstMatch.waitForExistence(timeout: 5)
        sleep(1)
        return all.allElementsBoundByIndex.last { $0.isHittable } ?? all.firstMatch
    }

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
        // Opening it brings its words back to the dock, ready to start.
        labelled(app, "Add retry with backoff to the upload client").firstMatch.tap()
        XCTAssertTrue(app.buttons["Start task"].waitForExistence(timeout: 10), "the draft opened nothing")
        snap(app, "type-draft-opened")
    }

    /// Anything on screen by its label: a row's title is read off its button, not a static text.
    func labelled(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// The list with nothing in it, from no server to a quiet one. Wants a second server with no
    /// sessions behind `/tmp/dray825-proxy.py`, and two projects on it, `thinking-orbs` one of them:
    ///   TEST_RUNNER_DRAY_EMPTY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_EMPTY_TOKEN=… TEST_RUNNER_DRAY_EMPTY_MODE=/tmp/…
    func testEmptyStates() throws {
        guard let url = env["DRAY_EMPTY_URL"], let token = env["DRAY_EMPTY_TOKEN"], let modeFile = env["DRAY_EMPTY_MODE"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_EMPTY_URL, TEST_RUNNER_DRAY_EMPTY_TOKEN and TEST_RUNNER_DRAY_EMPTY_MODE")
        }
        let mode = { (m: String) in try? m.write(toFile: modeFile, atomically: true, encoding: .utf8) }
        mode("hang")
        defer { mode("forward") }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        XCTAssertTrue(app.staticTexts["Connect a server"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Scan QR code"].exists && app.buttons["Enter an address"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["orb"].exists, "a dock before any server")
        // Nothing to show in either view, so neither button.
        XCTAssertFalse(app.buttons["Drafts"].exists || app.buttons["Settled"].exists, "view buttons with no server")
        sleep(1)
        snap(app, "empty-01-connect")

        connect(app, url: url, token: token)
        XCTAssertTrue(app.staticTexts["Connecting"].waitForExistence(timeout: 15), "no connecting screen")
        sleep(1)
        snap(app, "empty-02-connecting")

        mode("down")
        XCTAssertTrue(app.staticTexts["Can't reach Studio Mac"].waitForExistence(timeout: 60), "no can't-reach screen")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Trying again'")).firstMatch.exists)
        snap(app, "empty-03-unreachable")

        // Gone while a try of its own is out, back once it fails.
        let retry = app.buttons["Retry now"]
        XCTAssertTrue(retry.waitForExistence(timeout: 30), "no Retry now")
        mode("forward")
        retry.tap()
        XCTAssertTrue(app.staticTexts["No tasks yet"].waitForExistence(timeout: 30), "no empty list once connected")
        XCTAssertFalse(app.buttons["Drafts"].exists || app.buttons["Settled"].exists, "view buttons with nothing in them")
        sleep(1)
        snap(app, "empty-04-no-tasks")

        // The strip's, not the dock's project pick of the same name.
        app.descendants(matching: .any).matching(NSPredicate(format: "label == 'thinking-orbs'"))
            .allElementsBoundByIndex.min { $0.frame.minY < $1.frame.minY }?.tap()
        XCTAssertTrue(app.staticTexts["Nothing in thinking-orbs"].waitForExistence(timeout: 10), "no empty project")
        sleep(1)
        snap(app, "empty-05-project")
    }

    /// The same quiet server once a task was settled there today.
    func testAllClear() throws {
        guard let url = env["DRAY_EMPTY_URL"], let token = env["DRAY_EMPTY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_EMPTY_URL and TEST_RUNNER_DRAY_EMPTY_TOKEN")
        }
        let app = try pair(url: url, token: token)
        XCTAssertTrue(app.staticTexts["All clear"].waitForExistence(timeout: 30), "no all-clear screen")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'settled today.'")).firstMatch.exists)
        XCTAssertTrue(app.buttons["Settled"].exists && !app.buttons["Drafts"].exists, "Settled should show alone")
        sleep(1)
        snap(app, "empty-06-all-clear")
    }

    /// A fresh launch with no saved server, paired through the link a QR carries.
    func pair(url: String? = nil, token: String? = nil, offline: Bool = false) throws -> XCUIApplication {
        guard let url = url ?? env["DRAY_URL"], let token = token ?? env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""] + (offline ? ["-offline"] : [])
        app.launch()
        connect(app, url: url, token: token)
        return app
    }

    /// Adds a server through the link a QR carries.
    func connect(_ app: XCUIApplication, url: String, token: String) {
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Studio Mac")]
        app.open(link.url!)
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()
    }

    func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
