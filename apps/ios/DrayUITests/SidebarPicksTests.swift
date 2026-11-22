import XCTest

/// #1390: on an iPad or an unfolded iPhone Duo the list is a sidebar, and its foot is a New task
/// button, not the orb. It opens the new task page in the main pane: the phone's dock with every
/// pick, from which a real task starts. A phone keeps the dock under its list. The screenshot of
/// the selected row is the check that no focus ring is drawn round it (#1322).
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=Ops \
///   TEST_RUNNER_DRAY_SIDEBAR=1 xcodebuild test -only-testing:DrayUITests/SidebarPicksTests …
/// The server needs one project attached and `claude` on it. Run it on an unfolded Duo both ways
/// up: upright, the sidebar lies over the page and New task must shut it.
final class SidebarPicksTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testSidebarPicks() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let bot = env["DRAY_BOT"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, _TOKEN and _BOT")
        }
        let sidebar = env["DRAY_SIDEBAR"] == "1"
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-list.hideSessions", "NO"]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()

        // A narrower split view, an unfolded Duo upright, starts with its sidebar tucked away.
        let show = app.buttons["Show Sidebar"]
        func openSidebar() { if show.exists { show.tap(); sleep(1) } }
        let row = app.staticTexts[bot]
        if !row.waitForExistence(timeout: 15) { openSidebar() }
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no bot row")
        let picks = ["Model", "Machine", "Project", "More picks", "Keyboard"]
        guard sidebar else {
            // On a phone the dock is under the list, every pick in it.
            for p in picks { XCTAssertTrue(app.buttons[p].exists, "no \(p) under the list") }
            snap(app, "1-phone")
            return
        }

        // The tap focused the row and drew the system's white focus ring round it. It shows only
        // with DeviceHub closed, which otherwise takes the simulator's hardware keyboard.
        row.tap()
        sleep(2)
        if !row.isHittable { openSidebar() }
        snap(app, "1-sidebar")
        let newTask = app.buttons["New task"]
        XCTAssertTrue(newTask.isHittable, "no New task button")
        // The pane beside it has a dock of its own (the bot's chat, or the page aimed at a bot with
        // none yet); the sidebar has none.
        let edge = newTask.frame.maxX
        XCTAssertFalse(app.buttons.matching(identifier: "Keyboard").allElementsBoundByIndex.contains { $0.frame.maxX <= edge }, "an orb in the sidebar")

        newTask.tap()
        sleep(1)
        XCTAssertTrue(app.navigationBars["New task"].waitForExistence(timeout: 5), "no new task page")
        for p in picks { XCTAssertTrue(app.buttons[p].waitForExistence(timeout: 5), "no \(p) on the new task page") }
        snap(app, "2-new-task-page")

        for pick in ["Model", "Project"] {
            app.buttons[pick].tap()
            let runWith = app.staticTexts["Run with"]
            XCTAssertTrue(runWith.waitForExistence(timeout: 5), "\(pick) opened no Run with")
            // Done, not a swipe: on an unfolded Duo's turned inner screen a swipe down goes sideways.
            app.buttons["Done"].tap()
            XCTAssertTrue(runWith.waitForNonExistence(timeout: 5), "Run with stayed open")
        }

        // A real task, from this page.
        app.buttons["Keyboard"].tap()
        let prompt = app.textViews["New task"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        prompt.typeText("Reply with the single word HELLO and nothing else.")
        app.buttons["Done"].tap()
        sleep(1)
        snap(app, "3-ready")
        // In the chat, not the list's cells: earlier runs leave tasks titled HELLO there, and an
        // upright Duo shuts the sidebar, so where the reply sits on screen says nothing.
        let hello = NSPredicate(format: "label == 'HELLO'")
        let replied = { app.staticTexts.matching(hello).count > app.cells.staticTexts.matching(hello).count }
        XCTAssertFalse(replied(), "a HELLO outside the list before the task started")
        app.buttons["Start task"].tap()
        let deadline = Date.now.addingTimeInterval(120)
        while !replied() && Date.now < deadline { sleep(2) }
        XCTAssertTrue(replied(), "reply never landed")
        snap(app, "4-reply")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        // An unfolded Duo draws on its inner screen, the larger one; the main screen stays black.
        let screen = XCUIScreen.screens.max { $0.screenshot().image.size.width < $1.screenshot().image.size.width } ?? .main
        let shot = XCTAttachment(screenshot: screen.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
