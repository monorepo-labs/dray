import XCTest

/// #1416 against a real server and a real bot on a cheap model (`DRAY_BOT`): a long press on the
/// bot's reply opens the reactions and nothing else, the pick lands as a badge without moving
/// the chat, a second pick replaces it, and the note that tells the bot draws nowhere, sent or
/// queued behind a running turn. Then the bot's own reaction lands on the reader's message the
/// same way. Every prompt here is a real turn, and the chat may hold earlier runs of this test.
///   TEST_RUNNER_DRAY_URL=ws://127.0.0.1:… TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_BOT=Pip xcodebuild test -only-testing:DrayUITests/ReactionTests
final class ReactionTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testReactionsBothWays() throws {
        guard let name = env["DRAY_BOT"] else { throw XCTSkip("set TEST_RUNNER_DRAY_BOT") }
        let app = try connected()
        let bot = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(bot.waitForExistence(timeout: 20), "no bot row")
        bot.tap()
        XCTAssertTrue(app.dock.waitForExistence(timeout: 10), "the bot's chat did not open")

        // Words no earlier run left in the chat.
        let word = "pineapple \(Int.random(in: 100...999))"
        app.reply("Reply with exactly these two words: \(word)")
        let reply = app.staticTexts[word]
        XCTAssertTrue(reply.waitForExistence(timeout: 60), "the bot did not reply")
        // A message after it, so the reaction has rows under it to move.
        app.reply("Thanks. Now tell me one short fact about mangoes.")
        sleep(12)
        snap(app, "1-chat")

        // The reader's reaction: the set alone, and a badge that moves nothing.
        var before = places(app)
        var had = badges(app, "You reacted: Love").count
        reply.press(forDuration: 0.8)
        XCTAssertTrue(app.buttons["Love"].waitForExistence(timeout: 5), "a long press opened no reactions")
        XCTAssertEqual(["Like", "Love", "Laughing", "Celebrating", "Done", "Seen", "Sad"].filter { !app.buttons[$0].exists }, [])
        XCTAssertFalse(app.descendants(matching: .any)["Copy"].exists, "Copy came up with the reactions")
        snap(app, "2-picker")
        app.buttons["Love"].tap()
        XCTAssertTrue(lands(app, "You reacted: Love", from: had), "the reaction drew no badge")
        XCTAssertEqual(places(app, first: before.count), before, "the reaction moved the chat")
        snap(app, "3-reacted")

        // The bot hears of it through a note nobody sees, and may answer.
        sleep(15)
        XCTAssertFalse(note(app).exists, "the hidden note drew in the chat")
        snap(app, "4-bot-answered")

        // A second pick replaces the first.
        had = badges(app, "You reacted: Love").count
        reply.press(forDuration: 0.8)
        XCTAssertTrue(app.buttons["Like"].waitForExistence(timeout: 5))
        snap(app, "5-picker-current")
        app.buttons["Like"].tap()
        XCTAssertTrue(lands(app, "You reacted: Love", from: had, by: -1), "the first reaction stayed")
        sleep(15)

        // The press is a long one alone: a drag from the same message still scrolls the chat.
        let at = reply.frame.minY
        reply.swipeDown(velocity: .slow)
        XCTAssertGreaterThan(reply.frame.minY, at, "a drag on a bot's message did not scroll")

        // Mid-turn the note waits in the queue, and draws nothing there either.
        app.reply("Run the shell command `sleep 20`, then reply with one word.")
        XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 10), "the turn never started")
        sleep(6)
        had = badges(app, "You reacted: Celebrating").count
        reply.press(forDuration: 0.8)
        XCTAssertTrue(app.buttons["Celebrating"].waitForExistence(timeout: 5))
        app.buttons["Celebrating"].tap()
        XCTAssertTrue(lands(app, "You reacted: Celebrating", from: had), "a reaction mid-turn drew no badge")
        sleep(2)
        XCTAssertFalse(app.staticTexts["Queued"].exists, "the hidden note drew in the queue")
        XCTAssertFalse(note(app).exists, "the hidden note drew in the chat")
        snap(app, "6-mid-turn")
        // The note may be answered inside this turn or in one of its own; either way nothing draws it.
        for _ in 0..<90 where app.buttons["Stop"].exists { sleep(1) }
        XCTAssertFalse(app.buttons["Stop"].exists, "the turn never ended")
        sleep(15)
        XCTAssertFalse(note(app).exists, "the flushed note drew in the chat")
        snap(app, "7-after-queue")

        // The bot's reaction, on the reader's message: nothing moves for it either. It sleeps
        // first, so the chat is measured with the message drawn and no badge on it yet.
        had = badges(app, "Bot reacted: Like").count
        let ask = "Message \(Int.random(in: 100...999)): run the shell command `sleep 8`, then react to this message with a thumbs up instead of replying in words."
        app.reply(ask)
        XCTAssertTrue(app.staticTexts[ask].waitForExistence(timeout: 10), "the message did not draw")
        sleep(2)
        before = places(app, through: ask)
        snap(app, "8-before-bot-reacts")
        XCTAssertEqual(badges(app, "Bot reacted: Like").count, had, "the bot reacted before the chat was measured")
        XCTAssertTrue(lands(app, "Bot reacted: Like", from: had, timeout: 60), "the bot did not react")
        XCTAssertEqual(places(app, through: ask), before, "the bot's reaction moved the chat")
        sleep(3)
        snap(app, "9-bot-reacted")
    }

    /// Every line of the chat against its first, to the half point: where each sits and how large,
    /// whatever the scroll. `first` keeps to the lines that were there before, `through` to those
    /// down to the message saying it, since the working line under the chat comes and goes.
    private func places(_ app: XCUIApplication, first: Int? = nil, through: String? = nil) -> [String] {
        // One snapshot: read line by line, a reply landing meanwhile leaves the query naming a row that moved.
        func lines(_ e: XCUIElementSnapshot) -> [XCUIElementSnapshot] { (e.elementType == .staticText ? [e] : []) + e.children.flatMap(lines) }
        guard var all = try? lines(app.scrollViews.firstMatch.snapshot()), let top = all.first?.frame else { return [] }
        if let through, let at = all.lastIndex(where: { $0.label == through }) { all = Array(all[...at]) }
        let half = { (v: CGFloat) in (v * 2).rounded() / 2 }
        return all.prefix(first ?? all.count).map(\.frame).map { "\(half($0.minX)) \(half($0.minY - top.minY)) \(half($0.width)) \(half($0.height))" }
    }

    private func badges(_ app: XCUIApplication, _ label: String) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label))
    }

    /// Whether the chat comes to hold `by` more badges saying `label` than the `had` it did.
    private func lands(_ app: XCUIApplication, _ label: String, from had: Int, by: Int = 1, timeout: Int = 10) -> Bool {
        for _ in 0..<timeout * 2 where badges(app, label).count != had + by { usleep(500_000) }
        return badges(app, label).count == had + by
    }

    /// The hidden prompt a reaction sends the bot, were anything to draw it.
    private func note(_ app: XCUIApplication) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'The user reacted'")).firstMatch
    }

    /// A fresh app paired to the test server through its link.
    private func connected() throws -> XCUIApplication {
        guard let url = env["DRAY_URL"], let token = env["DRAY_TOKEN"] else {
            throw XCTSkip("set TEST_RUNNER_DRAY_URL and TEST_RUNNER_DRAY_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
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
