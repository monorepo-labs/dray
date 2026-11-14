import XCTest

/// Media a reply names by path, against a real server whose session's reply names
/// a screenshot under recordings, a PNG outside the served folders and a
/// recording: each is drawn with its path gone from the text, and the video goes full screen.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_TITLE=… xcodebuild test …
final class MediaPathTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testPathsDrawAsMedia() throws {
        let app = try pair()
        let row = labelled(app, env["DRAY_TITLE"] ?? "")
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no session listed")
        row.tap()
        XCTAssertTrue(app.buttons["Open image"].firstMatch.waitForExistence(timeout: 15), "no image in the transcript")
        sleep(4)
        app.windows.firstMatch.swipeDown()
        sleep(1)
        snap(app, "transcript")
        let paths = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "/tmp/ios-media-test"))
        XCTAssertEqual(paths.count, 0, "a drawn path still shows as text")
        XCTAssertEqual(app.buttons.matching(identifier: "Open image").count, 2, "both images should draw")

        let video = app.otherElements.matching(NSPredicate(format: "label CONTAINS[c] %@", "video")).firstMatch
        (video.exists ? video : app.windows.firstMatch).swipeUp()
        sleep(2)
        let player = app.otherElements.matching(NSPredicate(format: "label CONTAINS[c] %@", "video")).firstMatch
        if player.exists { player.tap() }
        let full = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "full screen")).firstMatch
        XCTAssertTrue(full.waitForExistence(timeout: 10), "no full screen button")
        snap(app, "player-controls")
        full.tap()
        sleep(3)
        snap(app, "full-screen")
    }

    private func pair() throws -> XCUIApplication {
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
