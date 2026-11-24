import XCTest

/// The kept issue and PR lists against two real `dray-serve`s, a "Mac" holding
/// one GitHub checkout and a "VPS" holding another, and a helper on the host
/// that closes and reopens through `gh`: an item closed between reads goes on
/// the next read, and a server switched off takes its items with it.
///
///   TEST_RUNNER_MAC_URL=… TEST_RUNNER_MAC_TOKEN=… TEST_RUNNER_VPS_URL=… TEST_RUNNER_VPS_TOKEN=…
///   TEST_RUNNER_HELPER=http://127.0.0.1:… TEST_RUNNER_REPO=<owner/name, the Mac's checkout>
///   TEST_RUNNER_ISSUE=<n> TEST_RUNNER_ISSUE_TITLE=… TEST_RUNNER_PR=<n> TEST_RUNNER_PR_TITLE=…
final class ServerListsTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testClosedAndSwitchedOff() throws {
        guard let mac = env["MAC_URL"], let macToken = env["MAC_TOKEN"], let vps = env["VPS_URL"], let vpsToken = env["VPS_TOKEN"],
              let repo = env["REPO"], let issue = env["ISSUE"], let issueTitle = env["ISSUE_TITLE"],
              let pr = env["PR"], let prTitle = env["PR_TITLE"] else {
            throw XCTSkip("set TEST_RUNNER_MAC_URL, _MAC_TOKEN, _VPS_URL, _VPS_TOKEN, _HELPER, _REPO, _ISSUE, _ISSUE_TITLE, _PR, _PR_TITLE")
        }
        helper("reopen", repo, issue, "issue")
        helper("reopen", repo, pr, "pr")
        defer {
            helper("reopen", repo, issue, "issue")
            helper("reopen", repo, pr, "pr")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-issues.tracker", "github", "-issues.githubScope", "all", "-pulls.people", "all"]
        app.launch()
        pair(app, mac, macToken, "Mac")
        pair(app, vps, vpsToken, "VPS")
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 20))
        let ask = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if ask.waitForExistence(timeout: 5) { ask.tap() }
        sleep(3)

        // Both read through the Mac first.
        openPage(app, "Issues")
        let pick = app.buttons.matching(NSPredicate(format: "identifier == 'issue.repo' AND label CONTAINS %@", String(repo.split(separator: "/").last!))).firstMatch
        if pick.waitForExistence(timeout: 15) { pick.tap() }
        XCTAssertTrue(row(app, "issue.row", issueTitle).waitForExistence(timeout: 60), "\(issueTitle) never drew")
        snap(app, "1-issues-before-close")
        app.buttons["Close"].tap()
        openPage(app, "Pull requests")
        XCTAssertTrue(row(app, "pull.row", prTitle).waitForExistence(timeout: 60), "\(prTitle) never drew")
        snap(app, "2-pulls-before-close")
        app.buttons["Close"].tap()

        // Closed on GitHub, then read again: gone from the open lists.
        helper("close", repo, issue, "issue")
        helper("close", repo, pr, "pr")
        openPage(app, "Issues")
        snap(app, "3-issues-reopened-page")
        refresh(app)
        XCTAssertTrue(gone(row(app, "issue.row", issueTitle), within: 30), "a refetch still lists the closed issue")
        snap(app, "4-issues-after-refetch")
        app.buttons["Close"].tap()
        openPage(app, "Pull requests")
        refresh(app)
        XCTAssertTrue(gone(row(app, "pull.row", prTitle), within: 30), "a refetch still lists the closed PR")
        snap(app, "5-pulls-after-refetch")
        app.buttons["Close"].tap()
        helper("reopen", repo, issue, "issue")
        helper("reopen", repo, pr, "pr")

        // The Mac off: nothing of its checkout draws, kept or read.
        flip(app, "Mac")
        openPage(app, "Issues")
        sleep(8)
        snap(app, "6-issues-mac-off")
        XCTAssertFalse(app.buttons["issue.row"].firstMatch.exists, "the Mac is off and its repository's issues still draw")
        XCTAssertTrue(app.buttons["issue.repo"].firstMatch.exists, "the VPS's repositories are not offered")
        app.buttons["Close"].tap()
        openPage(app, "Pull requests")
        sleep(8)
        snap(app, "7-pulls-mac-off")
        XCTAssertFalse(row(app, "pull.row", prTitle).exists, "the Mac is off and its PR still draws")
        app.buttons["Close"].tap()

        // Back on: back again, the reopened issue and PR with them.
        flip(app, "Mac")
        sleep(3)
        openPage(app, "Issues")
        if pick.waitForExistence(timeout: 15) { pick.tap() }
        XCTAssertTrue(row(app, "issue.row", issueTitle).waitForExistence(timeout: 60), "the Mac on, and its issues never came back")
        snap(app, "8-issues-mac-on")
        app.buttons["Close"].tap()
        openPage(app, "Pull requests")
        XCTAssertTrue(row(app, "pull.row", prTitle).waitForExistence(timeout: 60), "the Mac on, and its PR never came back")
        snap(app, "9-pulls-mac-on")
    }

    private func row(_ app: XCUIApplication, _ id: String, _ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", id, title)).firstMatch
    }

    private func gone(_ element: XCUIElement, within seconds: Int) -> Bool {
        for _ in 0..<seconds {
            if !element.exists { return true }
            sleep(1)
        }
        return !element.exists
    }

    private func refresh(_ app: XCUIApplication) {
        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
            .press(forDuration: 0.1, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)))
    }

    private func openPage(_ app: XCUIApplication, _ name: String) {
        let button = app.buttons[name]
        XCTAssertTrue(button.waitForExistence(timeout: 30), "no \(name) button")
        button.tap()
    }

    /// Turns a server off, or back on, from its page.
    private func flip(_ app: XCUIApplication, _ server: String) {
        app.buttons["Settings"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", server)).firstMatch.tap()
        let toggle = app.descendants(matching: .any)["server.on"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        toggle.tap()
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Done"].tap()
    }

    private func pair(_ app: XCUIApplication, _ url: String, _ token: String, _ name: String) {
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: name)]
        XCUIDevice.shared.system.open(link.url!)
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()
    }

    private func helper(_ verb: String, _ repo: String, _ n: String, _ kind: String) {
        guard let base = env["HELPER"] else { return }
        let done = expectation(description: verb)
        let url = URL(string: "\(base)/\(verb)?repo=\(repo)&n=\(n)&kind=\(kind)")!
        URLSession.shared.dataTask(with: url) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 30)
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
