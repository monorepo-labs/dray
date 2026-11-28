import XCTest

/// A swipe down on the short reply sheet closes it, keyboard and all, from the text or the
/// header; a long text still scrolls under a swipe, and the header still takes it to full height.
/// Against a server holding the task `TEST_RUNNER_DRAY_TASK`, with the microphone granted:
///   xcrun simctl privacy <udid> grant microphone com.yogesh.dray.ios
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_TASK="<title>" \
///   xcodebuild test -only-testing:DrayUITests/ReplySheetSwipeTests
final class ReplySheetSwipeTests: XCTestCase {
    func testSwipeDownClosesShortSheet() throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let title = env["DRAY_TASK"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, _TOKEN and _TASK")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-dictation.server", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test server")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }

        let row = app.staticTexts[title].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no task row")
        row.tap()
        XCTAssertTrue(app.buttons["Keyboard"].waitForExistence(timeout: 15), "no dock in the task")
        sleep(1)

        let screen = app.windows.firstMatch.frame
        let editor = app.textViews.firstMatch
        let keyboard = app.keyboards.firstMatch
        // The title reads Reply or Edit message by the draft, so the header is found by its Done.
        let header = {
            app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: screen.midX, dy: app.buttons["Done"].firstMatch.frame.midY))
        }

        func open(_ words: String) {
            app.buttons["Keyboard"].firstMatch.tap()
            XCTAssertTrue(editor.waitForExistence(timeout: 5), "the keyboard opened no sheet")
            XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "no keyboard")
            let tip = app.buttons["Continue"]
            if tip.waitForExistence(timeout: 1) { tip.tap() }
            sleep(1)
            XCTAssertGreaterThan(editor.frame.minY, screen.height * 0.3, "the sheet opened full height")
            if !words.isEmpty { editor.typeText(words) }
            sleep(1)
        }

        func closesBoth(_ how: String) {
            XCTAssertTrue(editor.waitForNonExistence(timeout: 5), "a swipe down \(how) left the sheet up")
            XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5), "a swipe down \(how) left the keyboard up")
            sleep(1)
        }

        // Down the text: the sheet goes, not just the keyboard.
        open("Swipe me away")
        let text = editor.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        text.press(forDuration: 0.05, thenDragTo: text.withOffset(CGVector(dx: 0, dy: 300)))
        closesBoth("the text")

        // Down the header, the sheet's own drag.
        open("")
        header().press(forDuration: 0.05, thenDragTo: header().withOffset(CGVector(dx: 0, dy: 300)))
        closesBoth("the header")

        // A text longer than the sheet scrolls under a swipe down, and the sheet stays.
        open("")
        editor.typeText((1...14).map { "Line \($0)" }.joined(separator: "\n"))
        sleep(1)
        let top = editor.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
        top.press(forDuration: 0.05, thenDragTo: top.withOffset(CGVector(dx: 0, dy: 80)))
        sleep(1)
        XCTAssertTrue(editor.exists, "a swipe down a scrolled text closed the sheet")
        XCTAssertTrue(keyboard.exists, "a swipe down a scrolled text closed the keyboard")

        // Full height by the header, back down short, then closed by Done.
        header().press(forDuration: 0.05, thenDragTo: header().withOffset(CGVector(dx: 0, dy: -200)))
        sleep(1)
        XCTAssertLessThan(editor.frame.minY, screen.height * 0.25, "the header didn't drag the sheet to full height")
        header().press(forDuration: 0.05, thenDragTo: header().withOffset(CGVector(dx: 0, dy: 70)))
        sleep(1)
        XCTAssertGreaterThan(editor.frame.minY, screen.height * 0.3, "the header didn't drag the sheet back down")
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(editor.waitForNonExistence(timeout: 5), "Done left the sheet up")
    }
}
