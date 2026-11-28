import XCTest

/// #1670 against a real server: the bot rows stand in the order the desktop set.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOTS=Marketer,Backup xcodebuild test …
final class BotOrderTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testBotsInPlacedOrder() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let names = env["DRAY_BOTS"]?.split(separator: ",").map(String.init) else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, TEST_RUNNER_DRAY_TOKEN and TEST_RUNNER_DRAY_BOTS")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "This Mac")]
        app.open(link.url!)
        let addButton = app.buttons["Add"]
        XCTAssertTrue(addButton.waitForExistence(timeout: 10), "the link opened no add sheet")
        addButton.tap()
        let rows = names.map { app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", $0)).firstMatch }
        for (row, name) in zip(rows, names) { XCTAssertTrue(row.waitForExistence(timeout: 20), "no \(name) row") }
        sleep(2)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "bots-" + names.joined(separator: "-")
        shot.lifetime = .keepAlways
        add(shot)
        let ys = rows.map(\.frame.minY)
        XCTAssertEqual(ys, ys.sorted(), "rows are not in the order \(names)")
    }
}
