import XCTest

/// A `dray://connect` link, the way the system Camera hands one over: it
/// opens Add server filled in, and Add connects. Same scratch server as
/// `SmokeTests`, through the same `TEST_RUNNER_DRAY_URL`/`_TOKEN`.
final class PairingTests: XCTestCase {
    func testPairLinkFillsAddServer() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launch()

        let encoded = url.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        app.open(URL(string: "dray://connect?url=\(encoded)&token=\(token)&name=Scratch%20Mac")!)

        let address = app.textFields["Address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10), "Add server never opened")
        XCTAssertEqual(address.value as? String, url)
        XCTAssertEqual(app.textFields["Name"].value as? String, "Scratch Mac")
        snap(app, "1-paired")

        // The scanner itself needs a camera; the simulator has none, so this sees its fallback.
        app.buttons["Scan QR code"].tap()
        snap(app, "2-scanner")
        app.buttons["Cancel"].firstMatch.tap()

        app.buttons["Add"].tap()
        app.buttons["Servers"].tap()
        XCTAssertTrue(app.staticTexts["Scratch Mac"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 15), "never connected")
        snap(app, "3-connected")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
