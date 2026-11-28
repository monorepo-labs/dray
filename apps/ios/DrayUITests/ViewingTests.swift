import XCTest

/// #1688: the chat on screen is told to its server (`set_viewing`), which holds that chat's push.
/// A second socket asks the server `viewed_elsewhere` at each step, the lease its push checks.
/// With `DRAY_CONTROL` (`scripts/viewing_relay.mjs`, the server's push relay) a reply is also
/// asked for at each step and the relay's alerts counted.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=<name>
///   TEST_RUNNER_DRAY_SESSION=<its chat's id> [TEST_RUNNER_DRAY_CONTROL=http://127.0.0.1:…]
///     xcodebuild test -only-testing:DrayUITests/ViewingTests
@MainActor
final class ViewingTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }
    private var probe: URLSessionWebSocketTask?
    private var nextId = 1

    func testChatOnScreenHoldsItsPush() async throws {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"], let name = env["DRAY_BOT"], let session = env["DRAY_SESSION"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL, _TOKEN, _BOT and _SESSION")
        }
        let control = env["DRAY_CONTROL"]
        try await openProbe(url, token)
        let app = XCUIApplication()
        // No phone of this simulator's on the server: the relay counts its own fake one alone.
        app.launchArguments = ["-servers", "", "-notify.allow", "<false/>"]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 20), "no bot row")
        sleep(2)
        try await viewed(session, false, "nothing open yet")

        bot.tap()
        try await viewed(session, true, "the chat open in the front")
        snap(app, "1-chat-open")
        if let control {
            let before = try await pushes(control)
            try await get(control, "send")
            let reply = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] 'pong'")).firstMatch
            XCTAssertTrue(reply.waitForExistence(timeout: 60), "the bot never replied")
            sleep(5)
            let after = try await pushes(control)
            XCTAssertEqual(after, before, "a reply to the chat on screen was pushed")
            snap(app, "2-replied-no-push")
        }

        // Past the server's 60s lease: the 20s renewal holds it.
        try await Task.sleep(for: .seconds(65))
        try await viewed(session, true, "the lease lapsed while the chat stayed open")

        app.navigationBars.buttons.element(boundBy: 0).tap()
        try await viewed(session, false, "back on the list")
        snap(app, "3-list")
        if let control { try await pushed(control, "a reply with the list on screen") }

        bot.tap()
        try await viewed(session, true, "the chat opened again")
        XCUIDevice.shared.press(.home)
        try await viewed(session, false, "the app in the background")
        if let control { try await pushed(control, "a reply with the app in the background") }

        app.activate()
        try await viewed(session, true, "back in the front, still on the chat")
        snap(app, "4-back")
    }

    /// The server's word on whether another connection shows `session`, waited on until it is `want`.
    private func viewed(_ session: String, _ want: Bool, _ step: String) async throws {
        var now: Bool?
        for _ in 0..<16 {
            now = try await ask("viewed_elsewhere", ["sessionId": session]) as? Bool
            if now == want { return }
            try await Task.sleep(for: .milliseconds(500))
        }
        XCTFail("\(step): viewed_elsewhere is \(now.map(String.init) ?? "nil"), wanted \(want)")
    }

    private func pushed(_ control: String, _ step: String) async throws {
        let before = try await pushes(control)
        try await get(control, "send")
        for _ in 0..<60 {
            if try await pushes(control) > before { return }
            try await Task.sleep(for: .seconds(1))
        }
        XCTFail("\(step): no push in 60s")
    }

    private func openProbe(_ url: String, _ token: String) async throws {
        let t = URLSession.shared.webSocketTask(with: URL(string: url)!)
        t.resume()
        let hello = try JSONSerialization.data(withJSONObject: ["v": 1, "token": token])
        try await t.send(.string(String(decoding: hello, as: UTF8.self)))
        _ = try await t.receive()
        probe = t
    }

    /// One call on the probe socket, skipping the events the server streams beside its replies.
    private func ask(_ cmd: String, _ args: [String: Any]) async throws -> Any? {
        guard let probe else { throw XCTSkip("no probe") }
        let id = nextId
        nextId += 1
        let frame = try JSONSerialization.data(withJSONObject: ["id": id, "cmd": cmd, "args": args])
        try await probe.send(.string(String(decoding: frame, as: UTF8.self)))
        while true {
            guard case .string(let text) = try await probe.receive(),
                  let reply = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  reply["id"] as? Int == id else { continue }
            if let err = reply["err"] { throw NSError(domain: "dray", code: 0, userInfo: [NSLocalizedDescriptionKey: "\(err)"]) }
            return reply["ok"]
        }
    }

    private func pushes(_ control: String) async throws -> Int {
        Int(String(decoding: try await get(control, "count"), as: UTF8.self)) ?? -1
    }

    @discardableResult
    private func get(_ control: String, _ route: String) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(from: URL(string: "\(control)/\(route)")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, "\(route): \(String(decoding: data, as: UTF8.self))")
        return data
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
