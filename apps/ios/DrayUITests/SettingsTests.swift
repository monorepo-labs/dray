import XCTest

/// Settings and a server's page against a real server, a screenshot of each.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… xcodebuild test …
final class SettingsTests: XCTestCase {
    func testSettingsScreens() throws {
        let app = try pair()
        app.buttons["Settings"].tap()
        XCTAssertTrue(labelled(app, "Dictation").waitForExistence(timeout: 10))
        sleep(2)
        snap(app, "settings-root")
        labelled(app, "Dictation").tap()
        sleep(1)
        snap(app, "settings-dictation")
        app.navigationBars.buttons.firstMatch.tap()
        labelled(app, "Notifications").tap()
        sleep(1)
        snap(app, "settings-notifications")
        app.navigationBars.buttons.firstMatch.tap()
        labelled(app, "Studio Mac").tap()
        sleep(2)
        snap(app, "server-detail")
        app.buttons["Remove server"].tap()
        sleep(1)
        snap(app, "server-remove")
    }

    func testNoServers() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        app.buttons["Settings"].tap()
        sleep(1)
        snap(app, "settings-empty")
        labelled(app, "Add server").tap()
        sleep(1)
        snap(app, "add-server")
    }

    /// A wrong token: the detail page's yellow card and its Scan QR code.
    func testTokenRefused() throws {
        guard let url = env["DRAY_URL"] else { throw XCTSkip("no server") }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: String(repeating: "0", count: 64)),
                           .init(name: "name", value: "hetzner-vps")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10))
        app.buttons["Add"].tap()
        app.buttons["Settings"].tap()
        labelled(app, "hetzner-vps").tap()
        XCTAssertTrue(app.buttons["Scan QR code"].waitForExistence(timeout: 20), "no token card")
        sleep(1)
        snap(app, "server-token-refused")
    }

    /// Pastes a connect line, adds the server, opens it, removes it: the confirming video.
    func testAddAndRemove() throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        sleep(1)
        app.buttons["Settings"].tap()
        sleep(1)
        labelled(app, "Add server").tap()
        let field = app.textFields["Address"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        UIPasteboard.general.string = "\(url) \(token)"
        field.tap()
        sleep(1)
        field.tap()
        let paste = app.menuItems["Paste"]
        if paste.waitForExistence(timeout: 3) { paste.tap() } else { field.typeText("\(url) \(token)") }
        sleep(1)
        let name = app.textFields["Name"]
        name.tap()
        name.typeText("studio")
        sleep(1)
        snap(app, "add-server-pasted")
        app.buttons["Add"].tap()
        let card = labelled(app, "studio")
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        sleep(3)
        card.tap()
        XCTAssertTrue(labelled(app, "Connected").waitForExistence(timeout: 20), "never connected")
        sleep(2)
        snap(app, "added-detail")
        app.buttons["Remove server"].tap()
        sleep(1)
        app.buttons["Remove"].tap()
        XCTAssertTrue(labelled(app, "Pair with a machine running Dray.").waitForExistence(timeout: 5), "server not removed")
        sleep(2)
        snap(app, "removed")
    }

    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func labelled(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// A fresh launch with no saved server, paired through the link a QR carries.
    private func pair() throws -> XCUIApplication {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
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

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
