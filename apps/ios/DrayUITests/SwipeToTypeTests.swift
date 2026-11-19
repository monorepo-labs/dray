import XCTest

/// A swipe up on the resting orb, or under it, opens the keyboard as its button does, on the
/// list, a bot's chat and a task's chat (#1302). A tap on the orb still records, a hold still does
/// nothing (the orb is tapped, never held), and a swipe up the chat above only scrolls. "Swipe up
/// to type" sits over the orb until the third swipe. Against `lone_bot_seed.py`'s `visible` home,
/// on a fresh install, since a launch argument would pin the swipe count, with the microphone
/// granted so Apple's engine keeps the orb:
///   xcrun simctl uninstall <udid> com.yogesh.dray.ios
///   xcrun simctl privacy <udid> grant microphone com.yogesh.dray.ios
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… xcodebuild test -only-testing:DrayUITests/SwipeToTypeTests
final class SwipeToTypeTests: XCTestCase {
    func testSwipeUpOpensKeyboard() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-dictation.server", "", "-list.hideSessions", "NO"]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test server")]
        app.open(link.url!)
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "the link opened no add sheet")
        add.tap()

        let orb = app.descendants(matching: .any)["orb"]
        let editor = app.textViews.firstMatch
        let hint = app.staticTexts["Swipe up to type"]
        let row = { (label: String) in
            app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
        }

        func opensKeyboard(_ screen: String, _ swipe: () -> Void) {
            swipe()
            XCTAssertTrue(editor.waitForExistence(timeout: 5), "a swipe up opened no keyboard on \(screen)")
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "no keyboard on \(screen)")
            sleep(1)
            snap(app, "\(screen)-keyboard")
            app.buttons["Done"].firstMatch.tap()
            XCTAssertTrue(editor.waitForNonExistence(timeout: 5), "Done left the sheet up on \(screen)")
            sleep(1)
        }
        func swipeOnOrb() { orb.swipeUp(velocity: .slow) }
        func swipeUnderOrb() {
            let start = orb.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1)).withOffset(CGVector(dx: 60, dy: 50))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -160)))
        }
        func records(_ screen: String) {
            orb.tap()
            let done = app.buttons["Done"]
            XCTAssertTrue(done.waitForExistence(timeout: 10), "a tap on the orb didn't record on \(screen)")
            XCTAssertFalse(editor.exists, "a tap on the orb opened the keyboard on \(screen)")
            sleep(2)
            snap(app, "\(screen)-tap")
            app.buttons["Cancel"].tap()
            app.buttons["Discard"].tap()
            XCTAssertTrue(done.waitForNonExistence(timeout: 10), "Discard left the recording up on \(screen)")
            sleep(1)
        }
        func chat(_ screen: String, hinted: Bool) {
            XCTAssertTrue(orb.waitForExistence(timeout: 15), "no orb on \(screen)")
            sleep(1)
            XCTAssertEqual(hint.exists, hinted, "the hint \(hinted ? "is missing" : "outlived three swipes") on \(screen)")
            opensKeyboard(screen, swipeOnOrb)
            opensKeyboard("\(screen)-under", swipeUnderOrb)
            records(screen)
            orb.press(forDuration: 1)
            sleep(2)
            XCTAssertFalse(app.buttons["Done"].exists || editor.exists, "a hold on the orb did something on \(screen)")
            // The chat above keeps its own swipe.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).press(
                forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)))
            sleep(1)
            XCTAssertFalse(editor.exists, "a swipe up the chat opened the keyboard on \(screen)")
        }

        XCTAssertTrue(row("Ops").waitForExistence(timeout: 20), "no bot row")
        XCTAssertTrue(orb.waitForExistence(timeout: 15), "no orb on the list")
        sleep(1)
        XCTAssertTrue(hint.exists, "no hint over the orb before any swipe")
        snap(app, "list-hint")
        opensKeyboard("list", swipeOnOrb)

        row("Ops").tap()
        chat("bot", hinted: true)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        sleep(1)

        row("Fix login redirect").tap()
        chat("task", hinted: false)
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
