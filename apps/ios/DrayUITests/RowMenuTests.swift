import XCTest

/// A task row's long-press menu carries the desktop sidebar's: Fork, Pin, Set aside, Mark unread,
/// Settle, Detach from parent and Delete, each landing on the server. Needs a live server holding
/// finished tasks "Alpha task", "Beta task", "Epsilon task", "Worktree task" (in a worktree) and
/// "Gamma parent" with a child "Delta child":
///   TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_MENU_URL=ws://127.0.0.1:47231
final class RowMenuTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }
    private var app: XCUIApplication!

    func testRowMenu() throws {
        guard let url = env["DRAY_MENU_URL"], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        XCTAssertTrue(row("Alpha task").waitForExistence(timeout: 15), "no rows after pairing")

        // A finished, unread row: everything but Mark unread, Unsettle and Detach.
        open("Alpha task")
        for item in ["Fork", "Pin", "Set aside", "Settle", "Delete"] {
            XCTAssertTrue(app.buttons[item].exists, "no \(item)")
        }
        for item in ["Mark unread", "Unsettle", "Detach from parent", "Unpin"] {
            XCTAssertFalse(app.buttons[item].exists, "\(item) on a finished top-level row")
        }
        shot("menu")

        // Pin leads it out under a heading; Unpin puts it back.
        app.buttons["Pin"].tap()
        XCTAssertTrue(app.staticTexts["Pinned"].waitForExistence(timeout: 5), "no Pinned heading")
        XCTAssertLessThan(row("Alpha task").frame.minY, row("Gamma parent").frame.minY, "pinned row not first")
        open("Alpha task")
        XCTAssertTrue(app.buttons["Unpin"].exists, "no Unpin on a pinned row")
        shot("menu-pinned")
        app.buttons["Unpin"].tap()
        XCTAssertTrue(app.staticTexts["Pinned"].waitForNonExistence(timeout: 5), "Pinned stayed after unpinning")

        // Set aside sinks it below every other row; Bring back lifts it again.
        open("Beta task")
        app.buttons["Set aside"].tap()
        XCTAssertTrue(waitFor { self.below("Beta task", all: ["Alpha task", "Epsilon task", "Gamma parent", "Worktree task"]) },
                      "set aside row did not sink")
        open("Beta task")
        XCTAssertTrue(app.buttons["Bring back"].exists, "no Bring back on an aside row")
        shot("menu-aside")
        app.buttons["Bring back"].tap()
        XCTAssertTrue(waitFor { !self.below("Beta task", all: ["Alpha task", "Epsilon task", "Gamma parent", "Worktree task"]) },
                      "brought back row stayed down")

        // Read it, then take the mark back.
        row("Alpha task").tap()
        back()
        open("Alpha task")
        XCTAssertTrue(app.buttons["Mark unread"].exists, "no Mark unread on a read row")
        shot("menu-read")
        app.buttons["Mark unread"].tap()
        open("Alpha task")
        XCTAssertFalse(app.buttons["Mark unread"].exists, "Mark unread offered on an unread row")
        dismiss()

        // A child row can be cut loose; after that it is a top-level row with nothing to detach.
        open("Delta child")
        XCTAssertTrue(app.buttons["Detach from parent"].exists, "no Detach on a nested row")
        shot("menu-nested")
        app.buttons["Detach from parent"].tap()
        sleep(1)
        open("Delta child")
        XCTAssertFalse(app.buttons["Detach from parent"].exists, "Detach still offered after detaching")
        dismiss()

        // Settle leaves the live list; Unsettle from the settled view brings it back.
        open("Gamma parent")
        app.buttons["Settle"].tap()
        XCTAssertTrue(row("Gamma parent").waitForNonExistence(timeout: 5), "settled row stayed in the live list")
        app.buttons["Settled"].tap()
        XCTAssertTrue(row("Gamma parent").waitForExistence(timeout: 5), "not in the settled view")
        open("Gamma parent")
        for item in ["Pin", "Set aside", "Settle", "Mark unread"] {
            XCTAssertFalse(app.buttons[item].exists, "\(item) on a settled row")
        }
        XCTAssertTrue(app.buttons["Unsettle"].exists, "no Unsettle on a settled row")
        shot("menu-settled")
        app.buttons["Unsettle"].tap()
        XCTAssertTrue(row("Gamma parent").waitForNonExistence(timeout: 5), "unsettled row stayed in the settled view")
        app.buttons["Settled"].tap()
        XCTAssertTrue(row("Gamma parent").waitForExistence(timeout: 5), "unsettled row not back in the live list")

        // Delete asks first, then the row goes.
        open("Epsilon task")
        app.buttons["Delete"].tap()
        let confirm = app.buttons.matching(NSPredicate(format: "label == 'Delete'")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "no delete confirm")
        shot("delete-confirm")
        confirm.tap()
        XCTAssertTrue(row("Epsilon task").waitForNonExistence(timeout: 10), "deleted row stayed")

        // Fork here opens the copy; it lists beside the original.
        open("Beta task")
        app.buttons["Fork"].tap()
        XCTAssertTrue(app.buttons["Fork here"].waitForExistence(timeout: 3), "no fork submenu")
        XCTAssertTrue(app.buttons["Fork in new worktree"].exists, "no worktree fork")
        shot("menu-fork")
        app.buttons["Fork here"].tap()
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.waitForExistence(timeout: 15), "the fork did not open")
        back()
        XCTAssertTrue(row("Beta task (fork)").waitForExistence(timeout: 5), "no forked row")
        // A fork has run no turn of its own, so there is nothing to mark unread.
        open("Beta task (fork)")
        XCTAssertFalse(app.buttons["Mark unread"].exists, "Mark unread on a fork that never ran")
        dismiss()

        // And into a worktree of its own.
        open("Worktree task")
        app.buttons["Fork"].tap()
        XCTAssertTrue(app.buttons["Fork in new worktree"].waitForExistence(timeout: 3), "no fork submenu")
        app.buttons["Fork in new worktree"].tap()
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.waitForExistence(timeout: 30), "the worktree fork did not open")
        back()
        XCTAssertTrue(row("Worktree task (fork)").waitForExistence(timeout: 5), "no worktree fork row")
        shot("after")
    }

    /// Attach names the one bot that could take the task — "Helper Bot", which has a chat,
    /// not "Empty Bot", which has none — and the task leaves the list for the bot's Tasks.
    /// Needs finished "Alpha task" and settled "Settled task" beside those two bots:
    /// With TEST_RUNNER_DRAY_ATTACH_TWO=1 both bots have chats, and a submenu lists them.
    ///   TEST_RUNNER_DRAY_TOKEN=… TEST_RUNNER_DRAY_ATTACH_URL=ws://127.0.0.1:47231
    func testAttachToBot() throws {
        guard let url = env["DRAY_ATTACH_URL"], let token = env["DRAY_TOKEN"] else { throw XCTSkip("no server") }
        var link = URLComponents(string: "dray://connect")!
        link.queryItems = [.init(name: "url", value: url), .init(name: "token", value: token), .init(name: "name", value: "Test Mac")]
        app = XCUIApplication()
        app.launchArguments = ["-servers", ""]
        app.launch()
        app.open(link.url!)
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 10), "the link opened no add sheet")
        app.buttons["Add"].tap()
        XCTAssertTrue(row("Alpha task").waitForExistence(timeout: 15), "no rows after pairing")
        XCTAssertTrue(row("Helper Bot").waitForExistence(timeout: 10), "no bot row")

        open("Alpha task")
        if env["DRAY_ATTACH_TWO"] != nil {
            // Both bots have chats: a submenu picks one. The menu's copy is the last match,
            // should a bot's list row also read as a button.
            XCTAssertFalse(app.buttons["Attach to Helper Bot"].exists, "a direct item with two bots")
            app.buttons["Attach to bot"].tap()
            let helper = app.buttons.matching(identifier: "Helper Bot")
            XCTAssertTrue(helper.firstMatch.waitForExistence(timeout: 3) && app.buttons["Empty Bot"].exists,
                          "the submenu does not list both bots")
            shot("menu-attach-two")
            helper.element(boundBy: helper.count - 1).tap()
        } else {
            // One bot could take it, so the item names that bot and attaches straight away.
            XCTAssertTrue(app.buttons["Attach to Helper Bot"].exists, "no direct Attach to Helper Bot")
            XCTAssertFalse(app.buttons["Attach to bot"].exists, "a submenu for a single bot")
            XCTAssertFalse(app.buttons["Attach to Empty Bot"].exists, "a bot with no chat offered")
            shot("menu-attach")
            app.buttons["Attach to Helper Bot"].tap()
        }
        XCTAssertTrue(row("Alpha task").waitForNonExistence(timeout: 10), "attached task stayed in the list")

        // A settled task can't be attached.
        app.buttons["Settled"].tap()
        XCTAssertTrue(row("Settled task").waitForExistence(timeout: 5), "no settled row")
        open("Settled task")
        XCTAssertFalse(app.buttons["Attach to bot"].exists, "Attach to bot on a settled row")
        dismiss()
        app.buttons["Settled"].tap()

        // It sits under the bot's Tasks now.
        row("Helper Bot").tap()
        let tasks = app.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 10), "no Tasks button")
        tasks.tap()
        XCTAssertTrue(app.staticTexts["Alpha task"].waitForExistence(timeout: 10), "attached task not in the bot's Tasks")
        shot("bot-tasks")
    }

    private func row(_ title: String) -> XCUIElement { app.staticTexts[title].firstMatch }

    private func open(_ title: String) {
        row(title).press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5), "no menu on \(title)")
    }

    /// Closes an open menu by tapping off it, near the top of the screen.
    private func dismiss() {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        _ = app.buttons["Delete"].waitForNonExistence(timeout: 3)
    }

    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
        _ = row("Alpha task").waitForExistence(timeout: 5)
    }

    private func below(_ title: String, all others: [String]) -> Bool {
        let y = row(title).frame.minY
        return others.allSatisfy { row($0).frame.minY < y }
    }

    private func waitFor(_ timeout: TimeInterval = 5, _ check: @escaping () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if check() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return check()
    }

    private func shot(_ name: String) {
        let s = XCTAttachment(screenshot: app.screenshot())
        s.name = name
        s.lifetime = .keepAlways
        add(s)
    }
}
