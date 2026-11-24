import XCTest

/// A machine a Mac shares and the phone also pairs directly draws once, the
/// direct way while it works and through the Mac while it doesn't (#1404, #1466).
/// Two `dray-serve`s, the "Mac" sharing the "VPS" as `vps`, each with sessions;
/// the VPS's direct address goes through a forwarder that `GET <proxy>/down`
/// and `/up` switch, standing in for a Tailscale or LAN route:
///   TEST_RUNNER_MAC_URL=… TEST_RUNNER_MAC_TOKEN=… TEST_RUNNER_VPS_URL=<forwarder>
///   TEST_RUNNER_VPS_TOKEN=… TEST_RUNNER_PROXY=http://127.0.0.1:… TEST_RUNNER_TITLE=<a VPS session's title>
///   xcodebuild test …
final class SharedTwinTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testOnceWhicheverWayWorks() throws {
        guard let mac = env["MAC_URL"], let macToken = env["MAC_TOKEN"], let vps = env["VPS_URL"],
              let vpsToken = env["VPS_TOKEN"], let proxy = env["PROXY"], let title = env["TITLE"] else {
            throw XCTSkip("set TEST_RUNNER_MAC_URL, _MAC_TOKEN, _VPS_URL, _VPS_TOKEN, _PROXY and _TITLE")
        }
        switchRoute(proxy, "up")
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        link(app, url: mac, token: macToken, name: "Mac")
        app.buttons["Add"].tap()
        XCTAssertTrue(rows(app, title).firstMatch.waitForExistence(timeout: 30), "no VPS session through the Mac")
        snap(app, "1-mac-only")

        link(app, url: vps, token: vpsToken, name: "VPS direct")
        app.buttons["Add"].tap()
        XCTAssertTrue(settle(app, title, rows: 1, via: false), "paired both ways, not once the direct way")
        snap(app, "2-both-paired")

        app.terminate()
        app.launchArguments = []
        app.launch()
        XCTAssertLessThanOrEqual(most(app, title, for: 12), 1, "a launch drew the VPS twice")
        XCTAssertEqual(rows(app, title).count, 1)
        snap(app, "3-relaunched")

        switchRoute(proxy, "down")
        XCTAssertTrue(settle(app, title, rows: 1, via: true, timeout: 40), "the direct way down, and the Mac's copy never came back")
        XCTAssertLessThanOrEqual(most(app, title, for: 4), 1, "the down twin's rows drew beside the copy")
        snap(app, "4-direct-down")

        switchRoute(proxy, "up")
        XCTAssertTrue(settle(app, title, rows: 1, via: false, timeout: 40), "the direct way back, and the copy stayed")
        snap(app, "5-direct-back")

        flip(app, "VPS direct")
        XCTAssertTrue(settle(app, title, rows: 1, via: true), "the direct one off, and no copy")
        snap(app, "6-direct-off")
        flip(app, "VPS direct")
        XCTAssertTrue(settle(app, title, rows: 1, via: false, timeout: 30), "the direct one on, and the copy stayed")

        app.buttons["Settings"].tap()
        labelled(app, "VPS direct").tap()
        XCTAssertTrue(app.buttons["Remove server"].waitForExistence(timeout: 5))
        app.buttons["Remove server"].tap()
        app.buttons["Remove"].tap()
        XCTAssertTrue(via(app).waitForExistence(timeout: 20), "removed, and the copy never came back")
        snap(app, "7-direct-removed")
        app.buttons["Done"].tap()
        XCTAssertTrue(settle(app, title, rows: 1, via: true))
    }

    /// Paired directly at an address that never answers: the Mac's copy carries it.
    func testUnreachableDirect() throws {
        guard let mac = env["MAC_URL"], let macToken = env["MAC_TOKEN"], let vpsToken = env["VPS_TOKEN"],
              let proxy = env["PROXY"], let title = env["TITLE"] else { throw XCTSkip("env as above") }
        switchRoute(proxy, "down")
        defer { switchRoute(proxy, "up") }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        link(app, url: mac, token: macToken, name: "Mac")
        app.buttons["Add"].tap()
        XCTAssertTrue(rows(app, title).firstMatch.waitForExistence(timeout: 30))
        link(app, url: env["VPS_URL"]!, token: vpsToken, name: "VPS direct")
        app.buttons["Add"].tap()
        XCTAssertTrue(settle(app, title, rows: 1, via: true, timeout: 40), "the VPS went with its direct way down")
        snap(app, "u-direct-unreachable")
    }

    /// Waits for the list to show `title` `rows` times and Settings to list the copy or not.
    private func settle(_ app: XCUIApplication, _ title: String, rows n: Int, via shown: Bool, timeout: TimeInterval = 20) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if rows(app, title).count == n {
                app.buttons["Settings"].tap()
                let ok = via(app).waitForExistence(timeout: 1) == shown
                app.buttons["Done"].tap()
                if ok { return true }
            }
            sleep(1)
        }
        return false
    }

    /// The most rows `title` drew, sampled for `seconds`.
    private func most(_ app: XCUIApplication, _ title: String, for seconds: Int) -> Int {
        (0..<seconds * 2).map { _ in
            usleep(500_000)
            return rows(app, title).count
        }.max() ?? 0
    }

    /// Turns a server off, or back on, from its page.
    private func flip(_ app: XCUIApplication, _ server: String) {
        app.buttons["Settings"].tap()
        labelled(app, server).tap()
        let toggle = app.descendants(matching: .any)["server.on"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        toggle.tap()
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Done"].tap()
    }

    private func switchRoute(_ proxy: String, _ to: String) {
        let done = expectation(description: to)
        URLSession.shared.dataTask(with: URL(string: "\(proxy)/\(to)")!) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 5)
    }

    private func rows(_ app: XCUIApplication, _ title: String) -> XCUIElementQuery {
        app.staticTexts.matching(NSPredicate(format: "label == %@", title))
    }

    private func via(_ app: XCUIApplication) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'via Mac'")).firstMatch
    }

    private func link(_ app: XCUIApplication, url: String, token: String, name: String) {
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: name)]
        XCUIDevice.shared.system.open(link.url!)
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        XCTAssertTrue(app.navigationBars["Add server"].waitForExistence(timeout: 10), "the link opened no add sheet")
    }

    private func labelled(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
