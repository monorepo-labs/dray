import Foundation

struct Transcript {
    var events: [AgentEvent] = []
    var ids: Set<String> = []
    var olderBefore: Int?

    mutating func append(_ e: AgentEvent) {
        guard !ids.contains(e.id) else { return }
        ids.insert(e.id)
        events.append(e)
    }
}

enum ToolState { case pending, done, failed }

struct ToolCall: Identifiable {
    let id: String
    let name: String
    let toolType: String
    let input: JSON
    let title: String?
    let output: String?
    let state: ToolState
    var images: [ImageRef] = []

    /// What the row names beside its verb — the desktop's `toolSummary`.
    var summary: String? { title ?? toolSummary(name, toolType, input) }
}

/// One drawn line of a turn's work.
enum Item: Identifiable {
    case text(id: String, text: String)
    case tool(ToolCall)
    /// Consecutive calls to one tool, behind one row.
    case group(id: String, name: String, calls: [ToolCall], targets: Int, target: String?)
    /// A prompt typed into the running turn: the reader's own words, kept on
    /// screen through a collapse.
    case prompt(id: String, text: String, from: String?, images: [ImageRef])
    case failure(id: String, text: String)

    var id: String {
        switch self {
        case .text(let id, _), .group(let id, _, _, _, _), .prompt(let id, _, _, _), .failure(let id, _): id
        case .tool(let call): call.id
        }
    }

    /// Moves whenever the row grows: a group keeps its first call's id but gains calls.
    var newestId: String {
        if case .group(_, _, let calls, _, _) = self, let last = calls.last { return last.id }
        return id
    }

    var isPrompt: Bool { if case .prompt = self { true } else { false } }
}

/// A user prompt to the `turn_completed` that closes it.
struct Turn: Identifiable {
    let id: String
    var prompt: (text: String, from: String?, images: [ImageRef])?
    var work: [Item] = []
    var completed = false
    /// The red row a failed turn closes on.
    var failure: String?
    /// The turn's last message, which a collapsed turn keeps on screen.
    var finalText: String?
    /// `finalText` was the last row of `work` and is dropped from it, so it
    /// draws in the same place whether the fold is open or not.
    var finalLifted = false

    var running: Bool { !completed }
    /// Rows a collapse would hide: queued prompts stay on screen.
    var rows: Int { work.filter { !$0.isPrompt }.count }
}

/// A stretch of a turn between queued prompts, each folding on its own so a
/// prompt stays where it was typed.
struct Segment {
    var items: [Item]
    var prompt: Item?
}

extension Turn {
    var segments: [Segment] {
        var out: [Segment] = []
        var items: [Item] = []
        for item in work {
            if item.isPrompt {
                out.append(Segment(items: items, prompt: item))
                items = []
            } else {
                items.append(item)
            }
        }
        out.append(Segment(items: items, prompt: nil))
        return out
    }
}

/// The pictures tools handed back in a folded stretch, drawn under its summary
/// line so a fold never hides them: the desktop's `segmentMedia`.
func foldedImages(_ items: [Item]) -> [ImageRef] {
    items.flatMap { item -> [ImageRef] in
        switch item {
        case .tool(let call): call.images
        case .group(_, _, let calls, _, _): calls.flatMap(\.images)
        default: []
        }
    }
}

/// One picture in a turn's gallery, and the line naming where it came from:
/// "Read /tmp/hero.png", "Attached IMG_2041.jpg".
struct Shot: Hashable {
    let ref: ImageRef
    let verb: String
    let target: String?
}

extension Turn {
    /// Every picture in the turn, in reading order: what the viewer pages through.
    var gallery: [Shot] {
        func attached(_ images: [ImageRef]) -> [Shot] {
            images.map { Shot(ref: $0, verb: "Attached", target: fileName($0)) }
        }
        func calls(_ calls: [ToolCall]) -> [Shot] {
            calls.flatMap { call in
                call.images.map { Shot(ref: $0, verb: toolLabel(call.name, pending: false), target: call.summary) }
            }
        }
        func shown(_ text: String) -> [Shot] {
            markdownBlocks(text).compactMap {
                guard case .image(let alt, let url) = $0 else { return nil }
                let ref = ImageRef(path: nil, url: url, mimeType: nil)
                return Shot(ref: ref, verb: "Image", target: alt.isEmpty ? fileName(ref) : alt)
            }
        }
        var out = attached(prompt?.images ?? [])
        for item in work {
            switch item {
            case .tool(let call): out += calls([call])
            case .group(_, _, let c, _, _): out += calls(c)
            case .prompt(_, _, _, let images): out += attached(images)
            case .text(_, let text): out += shown(text)
            case .failure: break
            }
        }
        if finalLifted, let finalText { out += shown(finalText) }
        // One page per picture: a tap finds it by ref, so a repeat would open on the first.
        var seen = Set<ImageRef>()
        return out.filter { seen.insert($0.ref).inserted }
    }
}

private func fileName(_ ref: ImageRef) -> String? {
    // A `data:` URL has no name, only bytes.
    (ref.path ?? ref.url).flatMap { $0.hasPrefix("data:") ? nil : $0.split(separator: "/").last.map(String.init) }
}

/// "3 tool calls · 1 message", the desktop's summary line.
func summaryLabel(_ items: [Item]) -> String {
    var calls = 0, messages = 0
    for item in items {
        switch item {
        case .tool: calls += 1
        case .group(_, _, let c, _, _): calls += c.count
        case .text: messages += 1
        default: break
        }
    }
    var parts: [String] = []
    if calls > 0 { parts.append(plural(calls, "tool call")) }
    if messages > 0 { parts.append(plural(messages, "message")) }
    return parts.isEmpty ? plural(items.count, "step") : parts.joined(separator: " · ")
}

func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }

/// The desktop's `buildTranscript`, cut down to what the phone draws:
/// subagents' own events are skipped, a call joins its result on `callId` and
/// is pending only while the session is busy, and runs of one tool group.
func buildTurns(_ events: [AgentEvent], busy: Bool) -> [Turn] {
    let main = events.filter { $0.subagent == nil }
    var results: [String: ToolResult] = [:]
    for e in main {
        if case .toolCompleted(let id, let r) = e.payload { results[id] = r }
    }
    // A prompt abandons every call still open before it: no result is coming.
    var abandoned: Set<String> = []
    var open: [String] = []
    for e in main {
        switch e.payload {
        case .toolStarted(let callId, _, _, _, _) where results[callId] == nil: open.append(callId)
        case .userMessage(_, _, _, false, _): abandoned.formUnion(open); open = []
        default: break
        }
    }

    var turns: [Turn] = []
    var current: Turn?
    var calls: [ToolCall] = []

    func flushCalls() {
        guard !calls.isEmpty else { return }
        if calls.count >= 2 {
            let names = calls.map { $0.summary ?? "\u{0}\($0.id)" }
            let distinct = Set(names)
            let only = distinct.count == 1 ? calls[0].summary : nil
            current?.work.append(.group(id: "group-\(calls[0].id)", name: calls[0].name,
                                        calls: calls, targets: distinct.count, target: only))
        } else {
            current?.work.append(.tool(calls[0]))
        }
        calls = []
    }

    func close() {
        flushCalls()
        guard var turn = current else { return }
        current = nil
        // The harness says a failure twice; the red row wins.
        if let failure = turn.failure, case .text(_, let last)? = turn.work.last,
           last.trimmingCharacters(in: .whitespacesAndNewlines) == failure.trimmingCharacters(in: .whitespacesAndNewlines) {
            turn.work.removeLast()
        }
        if turn.completed, case .text(_, let last)? = turn.work.last {
            turn.finalText = last
            turn.finalLifted = true
            turn.work.removeLast()
        } else if turn.completed {
            // Cut short with a call after its last message: that message still ends the fold.
            for case .text(_, let text) in turn.work.reversed() { turn.finalText = text; break }
        }
        turns.append(turn)
    }

    for e in main {
        switch e.payload {
        case .userMessage(let text, let fromTitle, let fromId, let queued, let images):
            let shown = stripSender(text, title: fromTitle, id: fromId)
            if queued, current != nil {
                flushCalls()
                current?.work.append(.prompt(id: e.id, text: shown, from: fromTitle, images: images))
            } else {
                close()
                current = Turn(id: e.id, prompt: (shown, fromTitle, images))
            }
        case .assistantText(let text) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
            if current == nil { current = Turn(id: "head-\(e.id)") }
            flushCalls()
            current?.work.append(.text(id: e.id, text: text))
        case .toolStarted(let callId, let name, let toolType, let input, let title):
            if current == nil { current = Turn(id: "head-\(e.id)") }
            let r = results[callId]
            let state: ToolState = r.map { $0.isError ? .failed : .done }
                ?? (busy && !abandoned.contains(callId) ? .pending : .done)
            let call = ToolCall(id: e.id, name: name, toolType: toolType, input: input,
                                title: title, output: r?.text, state: state, images: r?.images ?? [])
            // A delegated run keeps its own row, as the desktop's panel link does, and so
            // does a call carrying a picture: a closed group would hide it.
            let alone = toolType == "subagent_spawn" || !call.images.isEmpty
            if let last = calls.last, last.name != name || alone { flushCalls() }
            calls.append(call)
            if alone { flushCalls() }
        case .error(let message):
            if current == nil { current = Turn(id: "head-\(e.id)") }
            flushCalls()
            current?.work.append(.failure(id: e.id, text: message))
        case .turnCompleted(let failed, let finalText):
            if current == nil { current = Turn(id: "head-\(e.id)") }
            current?.completed = true
            if failed {
                // Empty as well as absent, as the desktop reads it: a harness can
                // send a failed turn's sentence as "".
                let said = finalText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                current?.failure = said.isEmpty ? "Turn failed" : said
            }
            close()
        default:
            break
        }
    }
    close()
    return turns
}

/// A relayed prompt opens with a line for the receiving agent; the bubble
/// names the sender instead. Rebuilt as `relay.ts` does up to the sender's id.
///
/// A sender on another machine is named with it, ` on <machine>`, which this
/// client does not keep. That much is read to the line's end rather than
/// rebuilt: everything before it matched whole, so it cannot take any of the
/// message, and without it a remote sender's line stayed drawn in the bubble.
func stripSender(_ text: String, title: String?, id: String?) -> String {
    guard let title, let id else { return text }
    let opening = "[message from the Dray session \"\(title)\" (\(id))"
    guard text.hasPrefix(opening) else { return text }
    let rest = text.dropFirst(opening.count)
    guard rest.hasPrefix("]\n\n") || rest.hasPrefix(" on "), let end = rest.range(of: "]\n\n") else { return text }
    return String(rest[end.upperBound...])
}
