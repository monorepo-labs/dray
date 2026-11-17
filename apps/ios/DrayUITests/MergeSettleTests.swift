import XCTest

/// A merge card's Merge lands the PR, and the server settles its task and removes
/// its worktree, whether the task runs on the chat's server or on another
/// machine the phone never connects to. Against a real server whose bot chat
/// holds two open cards, one per task:
///   TEST_RUNNER_DRAY_MERGE_URL=ws://127.0.0.1:47231 TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_MERGE_NUMBERS=1,2
/// `TEST_RUNNER_DRAY_SETTLED=url|token|sessionId,…` names each task and the server holding it.
final class MergeSettleTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testMergeCardsLand() throws {
        guard let url = env["DRAY_MERGE_URL"], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", "", "-list.hideSessions", "NO", "-bot.dismissedStalls", ""]
        app.launch()
        XCTAssertTrue(app.buttons["Enter an address"].waitForExistence(timeout: 10), "no empty list")
        app.buttons["Enter an address"].tap()
        for (field, text) in [("Address", url), ("Token", token), ("Name", "Test Mac")] {
            XCTAssertTrue(app.textFields[field].waitForExistence(timeout: 5), "no \(field) field")
            app.textFields[field].tap()
            app.textFields[field].typeText(text)
        }
        app.buttons["Add"].tap()
        let bot = app.staticTexts[env["DRAY_MERGE_BOT"] ?? "Settle Bot"].firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 15), "no bot row after pairing")
        if !app.buttons["Tasks"].exists { bot.tap() }
        XCTAssertTrue(app.buttons["Tasks"].waitForExistence(timeout: 15), "the bot's chat did not open")

        let numbers = (env["DRAY_MERGE_NUMBERS"] ?? "1,2").split(separator: ",").map(String.init)
        for number in numbers {
            let merge = app.buttons["Merge"].firstMatch
            XCTAssertTrue(merge.waitForExistence(timeout: 180), "no Merge on card #\(number)")
            snap(app, "\(number)-before")
            merge.tap()
            let squash = app.buttons["Squash and merge"]
            XCTAssertTrue(squash.waitForExistence(timeout: 5), "no merge methods")
            squash.tap()
            let merged = app.descendants(matching: .any)["Merged #\(number)"]
            XCTAssertTrue(merged.waitForExistence(timeout: 90), "card #\(number) never read merged")
            snap(app, "\(number)-merged")
        }
        // Each task, on whichever server holds it, ends settled with its tree gone.
        for check in (env["DRAY_SETTLED"] ?? "").split(separator: ",") {
            let part = check.split(separator: "|").map(String.init)
            XCTAssertEqual(part.count, 3, "DRAY_SETTLED wants url|token|sessionId")
            var settled = false
            for _ in 0..<30 where !settled {
                let found = try? row(url: part[0], token: part[1], id: part[2])
                settled = found?["archived"] as? Bool == true && found?["worktreeRemoved"] as? Bool == true
                if !settled { sleep(2) }
            }
            XCTAssertTrue(settled, "task \(part[2]) was not settled with its worktree removed")
        }
    }

    /// A session's index row, read straight off its server's wire.
    private func row(url: String, token: String, id: String) throws -> [String: Any]? {
        let socket = URLSession.shared.webSocketTask(with: URL(string: url)!)
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }
        let send = { (frame: [String: Any]) in
            let text = String(data: try JSONSerialization.data(withJSONObject: frame), encoding: .utf8)!
            let done = self.expectation(description: "sent")
            socket.send(.string(text)) { _ in done.fulfill() }
            self.wait(for: [done], timeout: 5)
        }
        try send(["v": 1, "token": token])
        try send(["id": 1, "cmd": "session_index_item", "args": ["sessionId": id]])
        for _ in 0..<20 {
            var got: String?
            let done = expectation(description: "frame")
            socket.receive { result in
                if case .success(.string(let text)) = result { got = text }
                done.fulfill()
            }
            wait(for: [done], timeout: 5)
            guard let got, let frame = try JSONSerialization.jsonObject(with: Data(got.utf8)) as? [String: Any] else { continue }
            if frame["id"] as? Int == 1 { return frame["ok"] as? [String: Any] }
        }
        return nil
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
