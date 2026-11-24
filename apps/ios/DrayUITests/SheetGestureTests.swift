import XCTest

/// The typing sheet opens short over the keyboard and its header drags it to full height, on the
/// list and in a task; in a bot's chat a swipe in from the right edge opens Tasks, a swipe across
/// a code block only scrolls it, and the left edge still goes back (#1415). Against a server
/// holding the bot `TEST_RUNNER_DRAY_BOT`, with one task, whose chat ends on a code block wider
/// than the screen starting `let WIDE`, with the microphone granted so the orb stays:
///   xcrun simctl privacy <udid> grant microphone com.yogesh.dray.ios
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=Ops \
///   xcodebuild test -only-testing:DrayUITests/SheetGestureTests
final class SheetGestureTests: XCTestCase {
    func testShortSheetAndEdgeSwipe() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let bot = env["DRAY_BOT"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, _TOKEN and _BOT")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-dictation.server", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test server")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        // A first launch asks about notifications, over whatever is tapped next.
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }

        let screen = app.windows.firstMatch.frame
        let editor = app.textViews.firstMatch
        let tasksSheet = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Tasks, ")).firstMatch
        let at = { (x: CGFloat, y: CGFloat) in app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)) }

        /// Opens short and goes to full height by its header alone. Words typed on the list would
        /// open the dock over it, so only the task's sheet is typed into.
        func typingSheet(_ screenName: String, title: String, typing: Bool) {
            app.buttons["Keyboard"].firstMatch.tap()
            XCTAssertTrue(editor.waitForExistence(timeout: 5), "the keyboard opened no sheet on \(screenName)")
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "no keyboard on \(screenName)")
            // A new simulator's keyboard opens on its own tip.
            let tip = app.buttons["Continue"]
            if tip.waitForExistence(timeout: 2) { tip.tap() }
            sleep(1)
            let short = editor.frame
            XCTAssertGreaterThan(short.minY, screen.height * 0.3, "the sheet opened full height on \(screenName)")
            XCTAssertLessThan(short.maxY, app.keyboards.firstMatch.frame.minY + 1, "the keyboard covers the text on \(screenName)")
            if typing { editor.typeText("Short sheet on \(screenName)") }
            snap(app, "\(screenName)-short")
            // A drag up the text leaves the sheet where it is.
            editor.swipeUp()
            sleep(1)
            XCTAssertGreaterThan(editor.frame.minY, screen.height * 0.3, "a swipe on the text resized the sheet on \(screenName)")
            let header = app.staticTexts[title].firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            header.press(forDuration: 0.05, thenDragTo: header.withOffset(CGVector(dx: 0, dy: -200)))
            sleep(1)
            XCTAssertLessThan(editor.frame.minY, screen.height * 0.25, "the header didn't drag the sheet to full height on \(screenName)")
            snap(app, "\(screenName)-full")
            // And back down by a short drag; a long one closes it, as before.
            header.press(forDuration: 0.05, thenDragTo: header.withOffset(CGVector(dx: 0, dy: 70)))
            sleep(1)
            XCTAssertGreaterThan(editor.frame.minY, screen.height * 0.3, "the header didn't drag the sheet back down on \(screenName)")
            app.buttons["Done"].firstMatch.tap()
            XCTAssertTrue(editor.waitForNonExistence(timeout: 5), "Done left the sheet up on \(screenName)")
            sleep(1)
        }

        let row = app.staticTexts[bot].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no bot row")
        XCTAssertTrue(app.buttons["Keyboard"].waitForExistence(timeout: 15), "no dock on the list")
        typingSheet("list", title: "New task", typing: false)

        row.tap()
        let tasks = app.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 10), "no Tasks button")
        let code = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "let WIDE")).firstMatch
        XCTAssertTrue(code.waitForExistence(timeout: 15), "no code block in the bot's chat")
        sleep(2)
        // A card under the reply can leave the code block up under the bar.
        for _ in 0..<4 where code.frame.midY < 180 {
            at(screen.midX, screen.height * 0.3).press(forDuration: 0.05, thenDragTo: at(screen.midX, screen.height * 0.55))
            sleep(1)
        }
        snap(app, "bot-chat")

        // Across the code block, from inside it and from its right end: it scrolls, nothing opens.
        let y = code.frame.midY, before = code.frame.minX
        at(screen.width * 0.8, y).press(forDuration: 0.05, thenDragTo: at(screen.width * 0.2, y))
        sleep(1)
        XCTAssertFalse(tasksSheet.exists, "a swipe across a code block opened Tasks")
        XCTAssertLessThan(code.frame.minX, before - 40, "the code block didn't scroll")
        snap(app, "code-scrolled")
        // Up the right edge: the chat scrolls, nothing opens.
        at(screen.width - 2, screen.height * 0.55).press(forDuration: 0.05, thenDragTo: at(screen.width - 2, screen.height * 0.3))
        sleep(1)
        XCTAssertFalse(tasksSheet.exists, "a swipe up the right edge opened Tasks")

        // In from the right edge: Tasks. At a finger's speed: the chat has just scrolled, and a slow
        // drag from under the scroll bar while it still shows is the system's grab of that bar.
        let edgeSwipe = {
            at(screen.width - 1, screen.height * 0.5).press(
                forDuration: 0.05, thenDragTo: at(screen.width * 0.4, screen.height * 0.5), withVelocity: 800, thenHoldForDuration: 0)
        }
        edgeSwipe()
        XCTAssertTrue(tasksSheet.waitForExistence(timeout: 5), "a swipe in from the right edge opened no Tasks sheet")
        sleep(1)
        snap(app, "tasks-by-swipe")
        let task = app.buttons.matching(identifier: "botTask").firstMatch
        XCTAssertTrue(task.waitForExistence(timeout: 5), "no task in the sheet")
        task.tap()
        XCTAssertTrue(tasksSheet.waitForNonExistence(timeout: 5), "the task left the sheet up")
        XCTAssertTrue(app.buttons["Keyboard"].waitForExistence(timeout: 15), "no dock in the task")
        sleep(1)
        // A task has no Tasks sheet to open.
        edgeSwipe()
        sleep(1)
        XCTAssertFalse(tasksSheet.exists, "the edge swipe opened Tasks in a task")
        typingSheet("task", title: "Reply", typing: true)

        snap(app, "task-after")
        // The left edge still goes back, to the bot's chat and then the list.
        at(0, screen.height * 0.5).press(forDuration: 0.05, thenDragTo: at(screen.width * 0.7, screen.height * 0.5))
        XCTAssertTrue(tasks.waitForExistence(timeout: 5), "the back swipe didn't return to the bot's chat")
        sleep(1)
        at(0, screen.height * 0.5).press(forDuration: 0.05, thenDragTo: at(screen.width * 0.7, screen.height * 0.5))
        XCTAssertTrue(tasks.waitForNonExistence(timeout: 5), "the back swipe didn't leave the bot's chat")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
