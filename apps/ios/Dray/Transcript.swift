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

/// One drawn line of a transcript.
enum Row: Identifiable {
    case user(id: String, text: String, from: String?)
    case assistant(id: String, text: String)
    case tool(id: String, line: String, output: String?, state: ToolState)
    case failure(id: String, text: String)

    var id: String {
        switch self {
        case .user(let id, _, _), .assistant(let id, _), .tool(let id, _, _, _), .failure(let id, _): id
        }
    }
}

enum ToolState { case pending, done, failed }

/// The desktop's transcript rules, cut down: subagents' own events are not
/// drawn, a tool call joins its result on `callId`, and a call with no result
/// is pending only while a turn could still produce one.
func buildRows(_ events: [AgentEvent], busy: Bool) -> [Row] {
    var results: [String: ToolResult] = [:]
    for e in events where e.subagent == nil {
        if case .toolCompleted(let id, let r) = e.payload { results[id] = r }
    }
    var rows: [Row] = []
    for e in events where e.subagent == nil {
        switch e.payload {
        case .userMessage(let text, let fromTitle, let fromId):
            rows.append(.user(id: e.id, text: stripSender(text, title: fromTitle, id: fromId), from: fromTitle))
        case .assistantText(let text) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
            rows.append(.assistant(id: e.id, text: text))
        case .toolStarted(let callId, let name, let input, let title):
            let r = results[callId]
            let state: ToolState = r.map { $0.isError ? .failed : .done } ?? (busy ? .pending : .done)
            rows.append(.tool(id: e.id, line: title ?? toolLine(name, input), output: r?.text, state: state))
        case .turnCompleted(true, let finalText):
            let text = finalText ?? "Turn failed"
            // The harness says the failure twice; the red row wins.
            if case .assistant(_, let last)? = rows.last, last == text { rows.removeLast() }
            rows.append(.failure(id: e.id, text: text))
        case .error(let message):
            rows.append(.failure(id: e.id, text: message))
        default:
            break
        }
    }
    return rows
}

/// A relayed prompt opens with a line for the receiving agent; the bubble
/// names the sender instead. Rebuilt exactly as `relay.ts` does, never parsed.
func stripSender(_ text: String, title: String?, id: String?) -> String {
    guard let title, let id else { return text }
    let prefix = "[message from the Dray session \"\(title)\" (\(id))]\n\n"
    return text.hasPrefix(prefix) ? String(text.dropFirst(prefix.count)) : text
}

/// "Edit Store.swift", "Bash pnpm test": the tool and what it acted on.
func toolLine(_ name: String, _ input: JSON) -> String {
    for field in ["file_path", "path", "command", "pattern", "url", "query", "description"] {
        guard let value = input[field]?.string, !value.isEmpty else { continue }
        let target = field.hasSuffix("path") ? (value as NSString).lastPathComponent : value
        return "\(name) \(target.split(separator: "\n").first ?? "")"
    }
    return name
}
