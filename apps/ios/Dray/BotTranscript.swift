import Foundation

/// One thing a bot's chat draws: the conversation, not the work. The desktop's
/// `botItems` in `botTranscript.ts`; keep the two in step.
enum BotItem: Identifiable {
    /// `reaction`: the bot's emoji on it, the newest where it reacted twice.
    case user(id: String, text: String, images: [ImageRef], reaction: String?, ts: String?)
    case assistant(id: String, text: String, ts: String?)
    /// A failed turn's sentence, or an error the harness raised.
    case notice(id: String, text: String, ts: String?)
    case card(id: String, MergeCard, ts: String?)
    /// "Started a new task", read off a `dray session new` and the id it printed.
    case task(id: String, sessionId: String, ts: String?)
    /// "Messaged", from a `dray session send`; consecutive ones fold into one row.
    case sent(id: String, target: String, ts: String?)
    /// A message another bot sent this one.
    case botMessage(id: String, botId: String, title: String, text: String, ts: String?)
    /// "Messaged" another bot, by the id `dray bot send` printed where it did.
    case botSent(id: String, name: String, botId: String?, ts: String?)
    case learned(id: String, lesson: Lesson, commit: String, undone: Bool, ts: String?)
    /// Where the chat moved to another session, and the agent it runs.
    case switchTo(id: String, harness: String?, ts: String?)

    var id: String {
        switch self {
        case .user(let id, _, _, _, _), .assistant(let id, _, _), .notice(let id, _, _), .card(let id, _, _),
             .task(let id, _, _), .sent(let id, _, _), .botMessage(let id, _, _, _, _), .botSent(let id, _, _, _),
             .learned(let id, _, _, _, _), .switchTo(let id, _, _): id
        }
    }

    var ts: String? {
        switch self {
        case .user(_, _, _, _, let ts), .assistant(_, _, let ts), .notice(_, _, let ts), .card(_, _, let ts),
             .task(_, _, let ts), .sent(_, _, let ts), .botMessage(_, _, _, _, let ts), .botSent(_, _, _, let ts),
             .learned(_, _, _, _, let ts), .switchTo(_, _, let ts): ts
        }
    }
}

/// A drawn row: an item, or a run of sends folded into one "Messaged" line.
enum BotRow: Identifiable {
    case item(BotItem)
    case talk(id: String, targets: [String], ts: String?)

    var id: String {
        switch self {
        case .item(let i): i.id
        case .talk(let id, _, _): id
        }
    }

    var ts: String? {
        switch self {
        case .item(let i): i.ts
        case .talk(_, _, let ts): ts
        }
    }
}

/// The chat's items from one session's events. Task reports carry no row: the
/// bot's reply already says what they held. Kickoffs and review turns draw nothing.
func botItems(_ events: [AgentEvent]) -> [BotItem] {
    let main = events.filter { $0.subagent == nil }
    var undone = Set<String>()
    for e in main { if case .learnedUndone(let commit, let path) = e.payload { undone.insert("\(commit)\0\(path)") } }
    // Read whole first, since a reaction lands after its message; the newest wins.
    var reactions: [String: String] = [:]
    for e in main { if case .reaction(let messageId, let emoji) = e.payload { reactions[messageId] = emoji } }

    var items: [BotItem] = []
    var starts = Set<String>()
    var sends: [String: [(target: String, bot: Bool)]] = [:]
    var review = false
    for e in main {
        switch e.payload {
        case .userMessage(let text, let fromTitle, let fromId, _, let images, let kickoff, let fromBot):
            review = kickoff && text.hasPrefix("Review:")
            if let fromBot {
                items.append(.botMessage(id: e.id, botId: fromBot, title: fromTitle ?? "",
                                         text: stripSender(text, title: fromTitle, id: fromId, bot: true), ts: e.ts))
            } else if fromId != nil {
                continue
            } else if !kickoff {
                items.append(.user(id: e.id, text: text, images: images, reaction: reactions[e.id], ts: e.ts))
            }
        case .assistantText(let text):
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !review {
                items.append(.assistant(id: e.id, text: text, ts: e.ts))
            }
        case .error(let message):
            items.append(.notice(id: e.id, text: message, ts: e.ts))
        case .mergeCard(let card):
            items.append(.card(id: e.id, card, ts: e.ts))
        case .learned(let commit, let files):
            for f in files {
                items.append(.learned(id: "\(e.id):\(f.path)", lesson: f, commit: commit,
                                      undone: undone.contains("\(commit)\0\(f.path)"), ts: e.ts))
            }
        case .turnCompleted(true, let finalText):
            let said = finalText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            // The harness says a failure twice; the red row wins.
            if !said.isEmpty, case .assistant(_, let last, _)? = items.last,
               last.trimmingCharacters(in: .whitespacesAndNewlines) == said {
                items.removeLast()
            }
            items.append(.notice(id: e.id, text: said.isEmpty ? "Turn failed" : said, ts: e.ts))
        case .toolStarted(let callId, _, _, let input, _):
            guard let cmd = command(input) else { continue }
            let plain = unquoted(cmd)
            if plain.firstMatch(of: startsSession) != nil { starts.insert(callId) }
            let s = sentMessages(cmd, plain)
            if !s.isEmpty { sends[callId] = s }
        case .toolCompleted(let callId, let result) where !result.isError:
            if starts.contains(callId), let m = result.text.firstMatch(of: taskId) {
                items.append(.task(id: callId, sessionId: String(m.output.1).lowercased(), ts: e.ts))
            }
            var botIds = result.text.matches(of: botSentLine).map { String($0.output.1).lowercased() }
            for (i, s) in (sends[callId] ?? []).enumerated() {
                let key = "\(callId):\(i)"
                if s.bot {
                    items.append(.botSent(id: key, name: s.target, botId: botIds.isEmpty ? nil : botIds.removeFirst(), ts: e.ts))
                } else {
                    items.append(.sent(id: key, target: s.target, ts: e.ts))
                }
            }
        default:
            break
        }
    }
    return items
}

/// Folds each run of task sends with nothing between into one "Messaged" row.
func botRows(_ items: [BotItem]) -> [BotRow] {
    var out: [BotRow] = []
    for item in items {
        if case .sent(let id, let target, let ts) = item {
            if case .talk(let runId, let targets, let runTs)? = out.last {
                out[out.count - 1] = .talk(id: runId, targets: targets + [target], ts: runTs)
            } else {
                out.append(.talk(id: id, targets: [target], ts: ts))
            }
        } else {
            out.append(.item(item))
        }
    }
    return out
}

/// Where unread replies begin: the first of the bot's replies after the
/// reader's own last message. The desktop's `firstUnread`.
func firstUnread(_ items: [BotItem]) -> String? {
    var mark: String?
    for item in items {
        switch item {
        case .user: mark = nil
        case .assistant(let id, _, _) where mark == nil: mark = id
        default: break
        }
    }
    return mark
}

/// Where unread replies begin among the items up to `upTo`, the last one the
/// chat held when it opened. Nil while not yet known: the reader's last message
/// may sit above what is loaded, so it waits for one of theirs or the whole chat
/// (`complete`). The desktop's `unreadStart`; `.some(nil)` is "settled, none".
func unreadStart(_ items: [BotItem], upTo: String, complete: Bool) -> String?? {
    let seen = items.firstIndex { $0.id == upTo }.map { Array(items[...$0]) } ?? items
    let mine = seen.contains { if case .user = $0 { true } else { false } }
    guard complete || mine else { return nil }
    return .some(firstUnread(seen))
}

/// The tool the bot is on now, for the orb line: "Bash dray session new …".
/// Nil once its turn has no call left open.
func currentTool(_ events: [AgentEvent]) -> String? {
    var done = Set<String>()
    for e in events.reversed() where e.subagent == nil {
        switch e.payload {
        case .userMessage, .turnCompleted: return nil
        case .toolCompleted(let id, _): done.insert(id)
        case .toolStarted(let id, let name, let toolType, let input, _) where !done.contains(id):
            let label = toolLabel(name, pending: true)
            return toolSummary(name, toolType, input).map { "\(label) \($0)" } ?? label
        default: break
        }
    }
    return nil
}

/// Whether the newest prompt is Dray's hidden review, whose reply never draws.
func inReviewTurn(_ events: [AgentEvent]) -> Bool {
    for e in events.reversed() where e.subagent == nil {
        if case .userMessage(let text, _, _, _, _, let kickoff, _) = e.payload { return kickoff && text.hasPrefix("Review:") }
    }
    return false
}

// MARK: Reading the bot's commands

private let startsSession = /\bdray\s+(session\s+new|new)\b/
private let taskId = /(?im)^\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/
/// What `dray bot send` prints, in `apps/cli/src/bot.rs`.
private let botSentLine = /(?im)^(?:Sent to|Queued for) bot ".*" \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\.$/
/// A session id, or a prefix of one long enough to name it.
private let sessionIdLike = /(?i)^[0-9a-f][0-9a-f-]{7,}$/

private func regex(_ p: String, _ o: NSRegularExpression.Options = []) -> NSRegularExpression {
    try! NSRegularExpression(pattern: p, options: o)
}
private let sends = regex(#"\bdray\s+(?:(session|bot)\s+)?send\b"#)
private let heredoc = regex(#"<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=[ \t]*(?:\n|\)|$))"#)
private let subshell = regex(#"\$\(\s*\w+\s+"#)
private let opener = regex(#"(?<!<)<<(?!<)-?[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([^\s'"<>;&|()]+))"#)

/// A Bash call's command: a string, or argv joined.
private func command(_ input: JSON) -> String? {
    switch input["command"] {
    case .string(let s)?: s
    case .array(let a)?: a.compactMap(\.string).joined(separator: " ")
    default: nil
    }
}

/// The length of `re`'s match starting exactly at `at`, or 0: JS's sticky flag.
private func stuck(_ re: NSRegularExpression, _ s: String, _ at: Int) -> Int {
    let n = (s as NSString).length
    guard at <= n else { return 0 }
    return re.firstMatch(in: s, options: [.anchored, .withTransparentBounds], range: NSRange(location: at, length: n - at))?.range.length ?? 0
}

/// `cmd` with every quoted string, escape and heredoc blanked to spaces, so a
/// `dray … send` spelled inside a message is never read as a command. Same
/// length in UTF-16, so an index into it is an index into `cmd`.
func unquoted(_ cmd: String) -> String {
    let s = cmd as NSString
    let n = s.length
    var out: [unichar] = []
    out.reserveCapacity(n)
    var i = 0
    func blank(_ end: Int) {
        while i < end { out.append(s.character(at: i) == 10 ? 10 : 32); i += 1 }
    }
    let lt: unichar = 60, nl: unichar = 10, slash: unichar = 92, single: unichar = 39, double: unichar = 34, dollar: unichar = 36
    var bodies: [String] = []
    while i < n {
        let c = s.character(at: i)
        if c == lt, let m = opener.firstMatch(in: cmd, options: [.anchored, .withTransparentBounds], range: NSRange(location: i, length: n - i)) {
            let word = (1...3).lazy.map { m.range(at: $0) }.first { $0.location != NSNotFound }.map(s.substring(with:)) ?? ""
            bodies.append(word)
            blank(i + m.range.length)
        } else if c == nl && !bodies.isEmpty {
            out.append(c)
            i += 1
            for word in bodies {
                let close = regex("^[ \\t]*\(NSRegularExpression.escapedPattern(for: word))[ \\t]*$\\n?", .anchorsMatchLines)
                // Unclosed, bash reads the body to the end of input and runs none of it.
                let m = close.firstMatch(in: cmd, range: NSRange(location: i, length: n - i))
                blank(m.map { $0.range.location + $0.range.length } ?? n)
            }
            bodies = []
        } else if c == slash {
            blank(min(i + 2, n))
        } else if c == single {
            let end = s.range(of: "'", range: NSRange(location: i + 1, length: n - i - 1)).location
            blank(end == NSNotFound ? n : end + 1)
        } else if c == double {
            var j = i + 1
            while j < n && s.character(at: j) != double {
                let sub = s.character(at: j) == dollar ? stuck(subshell, cmd, j) : 0
                let inner = sub > 0 ? stuck(heredoc, cmd, j + sub) : 0
                j += s.character(at: j) == slash ? 2 : inner > 0 ? sub + inner : 1
            }
            blank(min(j + 1, n))
        } else {
            out.append(c)
            i += 1
        }
    }
    return String(utf16CodeUnits: out, count: out.count)
}

/// Every `dray session send` and `dray bot send` in one command, with who to.
/// A session send to anything but an id — a loop's `"$id"` — is skipped rather
/// than drawn as a task that opens nothing. The message itself is never drawn.
func sentMessages(_ cmd: String, _ plain: String) -> [(target: String, bot: Bool)] {
    let s = cmd as NSString
    let n = s.length
    var out: [(target: String, bot: Bool)] = []
    for m in sends.matches(in: plain, range: NSRange(location: 0, length: (plain as NSString).length)) {
        let bot = m.range(at: 1).location != NSNotFound && (plain as NSString).substring(with: m.range(at: 1)) == "bot"
        var at = m.range.location + m.range.length
        func skipSpace() {
            while at < n, let u = Unicode.Scalar(s.character(at: at)), CharacterSet.whitespacesAndNewlines.contains(u) { at += 1 }
        }
        skipSpace()
        guard at < n else { continue }
        let rest = s.substring(from: at)
        let target: (word: String, length: Int)
        if let q = rest.first, q == "'" || q == "\"" {
            guard let end = rest.dropFirst().firstIndex(of: q) else { continue }
            let word = String(rest[rest.index(after: rest.startIndex)..<end])
            target = (word, (word as NSString).length + 2)
        } else {
            let word = String(rest.prefix { !$0.isWhitespace })
            target = (word, (word as NSString).length)
        }
        if !bot && target.word.wholeMatch(of: sessionIdLike) == nil { continue }
        at += target.length
        skipSpace()
        // No message after the target is no send.
        guard at < n else { continue }
        out.append((target.word, bot))
    }
    return out
}
