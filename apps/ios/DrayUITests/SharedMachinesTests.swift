import XCTest

/// A paired server sharing its machines lists each as a server of its own,
/// reached through it (#847). Against a live `dray-serve` that shares one
/// machine named `sandbox` — `dray machine share on` — and turns sharing off
/// within two minutes of launch, which takes the row away:
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… xcodebuild test …
final class SharedMachinesTests: XCTestCase {
    func testSharedMachineComesAndGoes() throws {
        let app = try pair()
        app.buttons["Settings"].tap()
        let relayed = labelled(app, "sandbox")
        XCTAssertTrue(relayed.waitForExistence(timeout: 20), "the shared machine is not listed")
        let via = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'via Studio Mac'")).firstMatch
        XCTAssertTrue(via.waitForExistence(timeout: 5), "the row does not say what it goes through")
        sleep(2)
        snap(app, "1-settings")

        relayed.tap()
        let reached = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Reached through Studio Mac'")).firstMatch
        XCTAssertTrue(reached.waitForExistence(timeout: 5))
        XCTAssertTrue(labelled(app, "Connected").waitForExistence(timeout: 20), "the relayed machine never connected")
        XCTAssertFalse(app.buttons["Remove server"].exists, "a relayed machine is not the phone's to remove")
        snap(app, "2-detail")
        app.navigationBars.buttons.firstMatch.tap()

        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: labelled(app, "sandbox"))
        waitForExpectations(timeout: 150)
        snap(app, "3-unshared")
    }

    private func pair() throws -> XCUIApplication {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Studio Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        return app
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
