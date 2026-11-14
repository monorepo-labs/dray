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

/// Made once: a formatter per call was the list's costliest line, every row's
/// time and every aside check building two.
private let fractionalDates: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
private let plainDates = ISO8601DateFormatter()
/// Even shared, a parse cost about 0.5ms, and the list re-sorts every session's
/// stamps on each redraw: 300 of them were half of a 350ms hang at launch.
private let parsedDates = NSCache<NSString, NSDate>()

func parseDate(_ s: String) -> Date? {
    if let hit = parsedDates.object(forKey: s as NSString) { return hit as Date }
    guard let d = fractionalDates.date(from: s) ?? plainDates.date(from: s) else { return nil }
    parsedDates.setObject(d as NSDate, forKey: s as NSString)
    return d
}

/// How long ago, as the sidebar says it: now, 4m, 1h, 3d.
func shortAge(_ date: Date, now: Date = .now) -> String {
    let s = Int(now.timeIntervalSince(date))
    return s < 60 ? "now" : s < 3600 ? "\(s / 60)m" : s < 86400 ? "\(s / 3600)h" : "\(s / 86400)d"
}

/// The server's first frame: what it can do and what it runs.
struct Welcome: Decodable {
    let dictation: Bool?
    /// The crate version: the app's own on a Mac.
    let version: String?
    /// The CLI release a `dray-serve` shipped in; none on a local build or a Mac.
    let release: String?
    let dev: Bool?

    /// Dray on a Mac, whose server follows the app's own updates.
    var macApp: Bool { dictation == true && release == nil && dev != true }
}

/// One index entry. Fields the phone does not read are left undecoded, so a
/// newer server adding some costs nothing.
struct SessionItem: Codable, Hashable {
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
    let branch: String?
    let worktreeName: String?
    let worktreeRemoved: Bool?
    let hidden: Bool?
    /// Set aside by the reader: started, not wanted now.
    let aside: Bool?
    let parentSessionId: String?
    let created: String?
    /// A bot task's one line to the reader, written by its bot (`dray session need`).
    let need: Need?
    /// The nearest live session above a bot's sub-task while the task that started it is settled or deleted.
    let adoptedBy: String?

    var busy: Bool { status == "in_progress" }
    var project: String { (projectPath as NSString).lastPathComponent }
}

/// A bot task's need: drawn only while written after the task last moved.
struct Need: Codable, Hashable {
    let text: String
    let at: String
}

/// A bot, as `list_bots` answers it. Its chat is any session whose `cwd` is `path`.
struct Bot: Codable, Hashable {
    let id: String
    let name: String
    let path: String
    /// Absent for a bot made before there was a pick, which draws the face its id seeds.
    let avatar: BotAvatar?
    /// Dray Bot's first words, drawn before its chat has a session.
    var welcome: String? = nil
}

/// `bot_previews`' answer per chat: its newest reply and how many came since the reader last wrote.
struct BotPreview: Codable, Hashable {
    let text: String?
    let replies: Int
}

/// A Blobatar face: a shape name and hue degrees.
struct BotAvatar: Codable, Hashable {
    let shape: String
    let hue: Double
}

/// One branch's pull request, as `pr_marks` answers it. Only `OPEN` and
/// `MERGED` are asked for; `checksState` is `RUNNING`, `FAILING` or `CLEAR`.
struct PrMark: Decodable, Hashable {
    let number: Int
    let headRefName: String
    let isDraft: Bool
    let state: String
    let checksState: String
    var url: String? = nil
    /// `MERGEABLE`, `CONFLICTING` or `UNKNOWN`; absent from an older server.
    var mergeable: String? = nil
    var mergeStateStatus: String? = nil
    var reviewDecision: String? = nil
}

struct Snapshot: Decodable {
    let events: [AgentEvent]
    let olderBefore: Int?
}

struct LiveState: Decodable {
    let asks: [AgentEvent]
    let tasks: [AgentEvent]
    /// Every non-empty queue; absent from a server that predates `queue_changed`.
    let queued: [QueueChanged]?
    /// Null until the app first reads a sandbox's timer.
    let boat: [BoatAlert]?
}

/// A boat sandbox about to auto-stop. The Mac app reads the timers and tells
/// its own server, so only the island ever hears one.
struct BoatAlert: Decodable, Hashable {
    /// The app's id for the machine, which `extend_boat` takes.
    let server: String
    let name: String
    let stopsAt: String?

    /// "boat-dray stops in 03:12", for the panel's one line.
    var sentence: String { "\(name) stops in \(countdown)" }

    /// "03:12" left.
    var countdown: String {
        let seconds = max(0, Int(secondsLeft ?? 0))
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }

    /// The last two minutes, which the pill draws red as the app's card does.
    var urgent: Bool { (secondsLeft ?? .infinity) <= 120 }

    private var secondsLeft: Double? {
        guard let stopsAt, let at = Self.parse(stopsAt) else { return nil }
        return at.timeIntervalSinceNow
    }

    private static func parse(_ text: String) -> Date? {
        let plain = ISO8601DateFormatter()
        if let at = plain.date(from: text) { return at }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text)
    }
}

/// What `share_machines` answers and `machines_shared` carries: the machines a
/// server lets this phone reach through it (#847). None while it shares none.
struct Sharing: Decodable {
    struct Machine: Decodable { let id: String; let name: String }
    let on: Bool
    let machines: [Machine]
}

struct BoatAlerts: Decodable {
    let alerts: [BoatAlert]
}

/// A session's whole queue, sent each time it moves.
struct QueueChanged: Decodable {
    let sessionId: String
    let queued: [Queued]
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
    let attachmentPaths: [String]

    enum CodingKeys: String, CodingKey { case id, text, attachmentPaths }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = try c.decode(String.self, forKey: .text)
        attachmentPaths = (try? c.decode([String].self, forKey: .attachmentPaths)) ?? []
    }
}

// MARK: Events

struct AgentEvent: Decodable, Identifiable {
    let id: String
    let sessionId: String
    let ts: String?
    /// Set on a subagent's own events, which the chat does not draw.
    let subagent: JSON?
    let payload: Payload
}

struct PermissionOption: Decodable, Hashable {
    let id: String
    let label: String
    let behavior: String
    /// `once`, `always_rule`, `always_directory`, `switch_mode` or `deny`; absent from an older server.
    let kind: String?
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

/// A picture on a prompt or a tool result. `path` is the archived copy under
/// `~/.dray/attachments`, read through the server's `/file`.
struct ImageRef: Decodable, Hashable {
    let path: String?
    let url: String?
    let mimeType: String?
}

/// One entry that may fail alone, so a bad image costs that image.
private struct LenientImage: Decodable {
    let ref: ImageRef?
    init(from decoder: Decoder) { ref = try? ImageRef(from: decoder) }
}

/// A list of images that never fails its event: absent or malformed reads as none.
func decodeImages(_ c: KeyedDecodingContainer<Key>) -> [ImageRef] {
    ((try? c.decode([LenientImage].self, forKey: "images")) ?? []).compactMap(\.ref)
}

struct ToolResult: Decodable {
    let text: String
    let isError: Bool
    let images: [ImageRef]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        text = try c.decode(String.self, forKey: "text")
        isError = try c.decodeIfPresent(Bool.self, forKey: "isError") ?? false
        images = decodeImages(c)
    }
}

enum Payload: Decodable {
    case turnCompleted(failed: Bool, finalText: String?)
    /// `queued` is a prompt typed into a running turn, which answers it inside that turn.
    /// `kickoff` is Dray's own prompt (a bot's greeting or review), drawn as nothing; `fromBot` names a bot that sent it.
    case userMessage(text: String, fromTitle: String?, fromId: String?, queued: Bool, images: [ImageRef],
                     kickoff: Bool = false, fromBot: String? = nil)
    case assistantText(String)
    case toolStarted(callId: String, name: String, toolType: String, input: JSON, title: String?)
    case toolCompleted(callId: String, result: ToolResult)
    case permissionRequested(PermissionRequest)
    case questionsAsked(QuestionsRequest)
    case permissionDecided(requestId: String)
    case backgroundTasks(count: Int)
    /// A merge card a bot posted, or Dray did once the PR was ready.
    case mergeCard(MergeCard)
    /// Lessons a bot turn filed, one per file, and one taken back.
    case learned(commit: String, files: [Lesson])
    case learnedUndone(commit: String, path: String)
    /// A bot's emoji on a message the user typed, in place of a reply.
    case reaction(messageId: String, emoji: String)
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
                // Optional values, and never a throw: a relay from this
                // machine carries `"machine": null`, which `[String: String]`
                // refuses — and a throw here costs the prompt, not its label.
                let from = (try? c.decodeIfPresent([String: String?].self, forKey: "from")) ?? nil
                self = .userMessage(
                    text: try c.decode(String.self, forKey: "text"),
                    fromTitle: from?["title"] ?? nil, fromId: from?["sessionId"] ?? nil,
                    queued: (try? c.decode(Bool.self, forKey: "queued")) ?? false,
                    images: decodeImages(c),
                    kickoff: (try? c.decode(Bool.self, forKey: "kickoff")) ?? false,
                    fromBot: from?["botId"] ?? nil)
            case "assistant_text":
                self = .assistantText(try c.decode(String.self, forKey: "text"))
            case "tool_call_started":
                self = .toolStarted(
                    callId: try c.decode(String.self, forKey: "callId"),
                    name: try c.decode(String.self, forKey: "name"),
                    toolType: (try? c.decode(String.self, forKey: "toolType")) ?? "other",
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
            case "merge_card":
                self = .mergeCard(try MergeCard(from: decoder))
            case "learned":
                self = .learned(commit: try c.decode(String.self, forKey: "commit"),
                                files: try c.decode([Lesson].self, forKey: "files"))
            case "learned_undone":
                self = .learnedUndone(commit: try c.decode(String.self, forKey: "commit"),
                                      path: try c.decode(String.self, forKey: "path"))
            case "reaction":
                self = .reaction(messageId: try c.decode(String.self, forKey: "messageId"),
                                 emoji: try c.decode(String.self, forKey: "emoji"))
            default:
                self = .other(type)
            }
        } catch {
            self = .other(type)
        }
    }

    /// Superseded or running counters the server never logs either.
    var isTransient: Bool {
        if case .other(let t) = self { return ["delta", "usage_update", "model_request_started", "repo_changed"].contains(t) }
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

/// `dray session merge-card`'s card: the task, its repo and the PR to land.
struct MergeCard: Decodable, Hashable {
    let taskId: String
    let title: String
    /// The repo root, where `pr_marks` and `merge_pr` run.
    let projectPath: String
    let branch: String
    let number: Int
    let url: String
    /// The machine holding the task, where it is not the chat's; `repo` comes with it.
    var machine: String? = nil
    var repo: String? = nil

    /// Where `pr_marks` and `merge_pr` run on the chat's server: the checkout, or for a
    /// task on another machine the GitHub slug, read through `gh` (`cardRepo`).
    var prPath: String { repo.map { "github:\($0)" } ?? projectPath }
}

/// One file a bot's turn changed under its instructions, skills or memory.
struct Lesson: Decodable, Hashable {
    let path: String
    /// `instructions`, `skill` or `memory`.
    let kind: String
    /// `added`, `changed` or `removed`.
    let change: String
    let summary: String
}
