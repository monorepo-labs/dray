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
