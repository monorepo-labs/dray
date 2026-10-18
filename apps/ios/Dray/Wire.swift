import Foundation

/// Any JSON value. Tool inputs are free-form, and call arguments go out as these.
enum JSON: Codable, Hashable {
    case null, bool(Bool), number(Double), string(String), array([JSON]), object([String: JSON])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSON].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        // Whole numbers go out as integers: serde refuses `1.0` for a `u32`.
        case .number(let n) where n == n.rounded() && abs(n) < 1e15: try c.encode(Int(n))
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    subscript(key: String) -> JSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var string: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// For an error reply, which is usually a sentence and occasionally an object.
    var message: String {
        if case .string(let s) = self { return s }
        let data = (try? JSONEncoder().encode(self)) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByNilLiteral, ExpressibleByArrayLiteral {
    init(stringLiteral value: String) { self = .string(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(integerLiteral value: Int) { self = .number(Double(value)) }
    init(nilLiteral: ()) { self = .null }
    init(arrayLiteral elements: JSON...) { self = .array(elements) }
    init(_ s: String?) { self = s.map(JSON.string) ?? .null }
    init(_ n: Int?) { self = n.map { .number(Double($0)) } ?? .null }
}

struct DrayError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// A key for decoding by name, so a payload reads `c.decode(String.self, forKey: "text")`.
struct Key: CodingKey, ExpressibleByStringLiteral {
    let stringValue: String
    init(stringValue: String) { self.stringValue = stringValue }
    init(stringLiteral value: String) { stringValue = value }
    var intValue: Int? { nil }
    init?(intValue: Int) { nil }
}

// MARK: Frames

struct Call: Encodable {
    let id: Int
    let cmd: String
    let args: [String: JSON]
}

/// What every incoming frame is read as first, to route it.
struct Head: Decodable {
    let id: Int?
    let event: String?
    let err: JSON?
}

/// `{"id":n,"ok":…}` or `{"id":n,"err":…}`. A rejected call throws its own sentence.
struct Reply<T: Decodable>: Decodable {
    let ok: T

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        if let err = try c.decodeIfPresent(JSON.self, forKey: "err") { throw DrayError(err.message) }
        ok = try c.decode(T.self, forKey: "ok")
    }
}

struct EventFrame<T: Decodable>: Decodable {
    let payload: T
}

// MARK: Sessions

/// One index entry. Fields the phone does not read are left undecoded, so a
/// newer server adding some costs nothing.
struct SessionItem: Decodable, Hashable {
    let sessionId: String
    let harness: String
    let cwd: String
    let projectPath: String
    var title: String
    let model: String
    let effort: String?
    let permissionMode: String
    let fast: Bool?
    var status: String
    var modified: String
    let archived: Bool?
    let hidden: Bool?

    var busy: Bool { status == "in_progress" }
    var project: String { (projectPath as NSString).lastPathComponent }
}

struct Snapshot: Decodable {
    let events: [AgentEvent]
    let olderBefore: Int?
}

struct LiveState: Decodable {
    let asks: [AgentEvent]
    let tasks: [AgentEvent]
}

struct StatusEvent: Decodable {
    let sessionId: String
    let status: String
    let modified: String?
}

struct TitleEvent: Decodable {
    let sessionId: String
    let title: String
}

struct SendOutcome: Decodable {
    /// The new index entry, flattened into a snapshot; only on the send that created it.
    let snapshot: SessionItem?
    let queued: Queued?
}

struct Queued: Decodable, Hashable {
    let id: String
    let text: String
}

// MARK: Events

struct AgentEvent: Decodable, Identifiable {
    let id: String
    let sessionId: String
    /// Set on a subagent's own events, which the chat does not draw.
    let subagent: JSON?
    let payload: Payload
}

struct PermissionOption: Decodable, Hashable {
    let id: String
    let label: String
    let behavior: String
}

struct PermissionRequest: Decodable, Hashable {
    let requestId: String
    let toolName: String
    let displayName: String?
    let title: String?
    let description: String?
    let input: JSON?
    let options: [PermissionOption]
}

struct QuestionOption: Decodable, Hashable {
    let label: String
    let description: String?
}

struct Question: Decodable, Hashable {
    let question: String
    let header: String?
    let multiSelect: Bool
    let options: [QuestionOption]
    /// False on pi's select and confirm, which take an offered option or nothing.
    let freeText: Bool?
}

struct QuestionsRequest: Decodable, Hashable {
    let requestId: String
    let questions: [Question]
}

struct ToolResult: Decodable {
    let text: String
    let isError: Bool
}

enum Payload: Decodable {
    case turnCompleted(failed: Bool, finalText: String?)
    case userMessage(text: String, fromTitle: String?, fromId: String?)
    case assistantText(String)
    case toolStarted(callId: String, name: String, input: JSON, title: String?)
    case toolCompleted(callId: String, result: ToolResult)
    case permissionRequested(PermissionRequest)
    case questionsAsked(QuestionsRequest)
    case permissionDecided(requestId: String)
    case backgroundTasks(count: Int)
    case error(String)
    case other(String)

    /// A payload whose shape moved decodes as `.other` rather than failing the
    /// event, and with it the whole list it arrived in.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let type = (try? c.decode(String.self, forKey: "type")) ?? "unknown"
        do {
            switch type {
            case "turn_completed":
                // A user's Stop ends a turn as `error` too; the desktop's `drawsFailure` rule.
                let stop = try c.decodeIfPresent(String.self, forKey: "stopReason") ?? ""
                self = .turnCompleted(
                    failed: try c.decode(String.self, forKey: "status") == "error" && !stop.hasPrefix("aborted"),
                    finalText: try c.decodeIfPresent(String.self, forKey: "finalText"))
            case "user_message":
                let from = try c.decodeIfPresent([String: String].self, forKey: "from")
                self = .userMessage(
                    text: try c.decode(String.self, forKey: "text"),
                    fromTitle: from?["title"], fromId: from?["sessionId"])
            case "assistant_text":
                self = .assistantText(try c.decode(String.self, forKey: "text"))
            case "tool_call_started":
                self = .toolStarted(
                    callId: try c.decode(String.self, forKey: "callId"),
                    name: try c.decode(String.self, forKey: "name"),
                    input: (try? c.decode(JSON.self, forKey: "input")) ?? .null,
                    title: try c.decodeIfPresent(String.self, forKey: "title"))
            case "tool_call_completed":
                self = .toolCompleted(
                    callId: try c.decode(String.self, forKey: "callId"),
                    result: try c.decode(ToolResult.self, forKey: "result"))
            case "permission_requested":
                self = .permissionRequested(try PermissionRequest(from: decoder))
            case "questions_asked":
                self = .questionsAsked(try QuestionsRequest(from: decoder))
            case "permission_decided":
                self = .permissionDecided(requestId: try c.decode(String.self, forKey: "requestId"))
            case "background_tasks_changed":
                self = .backgroundTasks(count: try c.decode([JSON].self, forKey: "tasks").count)
            case "error":
                self = .error(try c.decode(String.self, forKey: "message"))
            default:
                self = .other(type)
            }
        } catch {
            self = .other(type)
        }
    }

    /// Superseded or running counters the server never logs either.
    var isTransient: Bool {
        if case .other(let t) = self { return ["delta", "usage_update", "model_request_started"].contains(t) }
        return false
    }

    var askId: String? {
        switch self {
        case .permissionRequested(let r): r.requestId
        case .questionsAsked(let r): r.requestId
        default: nil
        }
    }
}
