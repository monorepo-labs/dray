import XCTest

/// #1322: on an iPad or an unfolded iPhone Duo the list is a sidebar, and its dock
/// shows model, project and the keyboard alone; Model and Project still open Run with,
/// which holds the server and every other pick. A phone keeps every pick. The screenshot
/// of the selected row is the check that no focus ring is drawn round it.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=Ops \
///   TEST_RUNNER_DRAY_SIDEBAR=1 xcodebuild test -only-testing:DrayUITests/SidebarPicksTests …
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
        row.tap()
        sleep(2)
        if sidebar && !row.isHittable { openSidebar() }
        // The tap focused the row and drew the system's white focus ring round it. It shows only
        // with DeviceHub closed, which otherwise takes the simulator's hardware keyboard.
        snap(app, "1-sidebar")
        // The open chat beside the sidebar has a dock of its own; only the list's, leftmost, counts.
        let edge = app.windows.firstMatch.frame.width / 2
        func listDock(_ label: String) -> XCUIElement? {
            app.buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex.first { $0.frame.maxX < edge || !sidebar }
        }
        XCTAssertNotNil(listDock("Model"), "no model pick")
        XCTAssertNotNil(listDock("Project"), "no project pick")
        XCTAssertNotNil(listDock("Keyboard"), "no keyboard")
        XCTAssertEqual(listDock("Machine") != nil, !sidebar, "machine pick")
        XCTAssertEqual(listDock("More picks") != nil, !sidebar, "more picks")

        for pick in ["Model", "Project"] {
            guard let button = listDock(pick) else { continue }
            button.tap()
            XCTAssertTrue(app.staticTexts["Run with"].waitForExistence(timeout: 5), "\(pick) opened no Run with")
            snap(app, "2-run-with-from-\(pick.lowercased())")
            // The machine and what "···" opened, all here.
            for label in ["Server", "Worktree", "Permissions"] {
                XCTAssertTrue(app.staticTexts[label].exists, "\(label) missing from Run with")
            }
            app.swipeDown(velocity: .fast)
            sleep(1)
        }
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
