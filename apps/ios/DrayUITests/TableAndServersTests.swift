import XCTest

/// A markdown table in a reply grows its rows and stays inside the bubble, and
/// Settings lists five servers with the rest behind All servers. Against a real
/// server holding a chat titled `DRAY_TABLE_CHAT` whose reply carries this table:
///   | PR | What it does |
///   |---|---|
///   | #888 | Accounts, stage 3: MCP sign-in through drayhq.com |
///   | #889 | Accounts, stage 4: sign in from the app. Link on every server |
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_TABLE_CHAT="Cloud PR table" xcodebuild test …
final class TableAndServersTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testTableAndServerList() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let chat = env["DRAY_TABLE_CHAT"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN and TEST_RUNNER_DRAY_TABLE_CHAT")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        // Opening a link relaunches the app, and `-servers ""` would empty the list each time.
        app.launchArguments = []
        add(app, "Studio Mac", url, token)

        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", chat)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no row for \(chat)")
        row.tap()
        let wide = app.staticTexts["Accounts, stage 3: MCP sign-in through drayhq.com"]
        XCTAssertTrue(wide.waitForExistence(timeout: 20), "the table never drew")
        sleep(2)
        snap(app, "table-end")
        app.swipeDown()
        sleep(1)
        snap(app, "table-top")
        // The long cell wraps: taller than one line, clear of the next row, inside the screen.
        let next = app.staticTexts["#889"]
        XCTAssertGreaterThan(wide.frame.height, next.frame.height * 1.5, "the long cell did not wrap")
        XCTAssertLessThanOrEqual(wide.frame.maxY, next.frame.minY + 1, "a wrapped cell ran into the next row")
        XCTAssertLessThanOrEqual(wide.frame.maxX, app.windows.firstMatch.frame.maxX, "the table ran past the screen")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Six more: unreachable ones are still servers in the list.
        for i in 1...6 { add(app, "Machine \(i)", "ws://127.0.0.1:\(1 + i)", String(repeating: "0", count: 64)) }
        app.buttons["Settings"].tap()
        let all = app.descendants(matching: .any)["settings.allServers"]
        XCTAssertTrue(all.waitForExistence(timeout: 10), "no All servers row with seven servers")
        XCTAssertFalse(app.staticTexts["Machine 5"].exists, "Settings listed a sixth server")
        snap(app, "settings")
        all.tap()
        XCTAssertTrue(app.staticTexts["Machine 6"].waitForExistence(timeout: 5), "All servers left one out")
        snap(app, "all-servers")
    }

    private func add(_ app: XCUIApplication, _ name: String, _ url: String, _ token: String) {
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: name)]
        app.open(link.url!)
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()
        XCTAssertTrue(add.waitForNonExistence(timeout: 5))
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
