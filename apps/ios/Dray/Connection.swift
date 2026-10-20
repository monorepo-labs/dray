import Foundation

/// The server protocol version this build speaks; `serve.rs`'s `PROTOCOL`.
let serveProtocol = 1

/// One WebSocket to one `dray-serve`, reconnecting on its own.
@MainActor
final class Connection {
    enum State: Equatable {
        case connecting, connected
        case failed(String)
    }

    let serverId: UUID
    private(set) var url: String
    private(set) var token: String
    /// Reads the address afresh before each connect, for a server whose port
    /// moves on every restart — the Notch's This Mac. `nil` keeps the first.
    var refresh: (() -> (url: String, token: String)?)?
    /// Whether the server can transcribe a phone's dictation; its welcome frame says.
    private(set) var dictation = false
    /// Every event frame, whole, with its name. Decoded by the store, which knows the type.
    var onEvent: (String, Data) -> Void = { _, _ in }
    var onState: (State) -> Void = { _ in }

    private var task: URLSessionWebSocketTask?
    private var connected = false
    private var generation = 0
    private var retry: Double = 1
    private var nextId = 1
    private var waiting: [Int: CheckedContinuation<Data, Error>] = [:]

    init(serverId: UUID, url: String, token: String) {
        self.serverId = serverId
        self.url = url
        self.token = token
    }

    /// Reconnects unless already connected. Called on launch and whenever the
    /// app comes back to the front, since iOS drops sockets in the background.
    func resume() {
        if !connected { connect() }
    }

    func stop() {
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        drop("Disconnected")
    }

    private func connect() {
        generation += 1
        let gen = generation
        task?.cancel(with: .goingAway, reason: nil)
        drop("Reconnecting")
        if let fresh = refresh?() { (url, token) = fresh }
        guard let address = socketURL(url) else {
            onState(.failed("Not an address: \(url)"))
            return
        }
        let t = URLSession.shared.webSocketTask(with: address)
        // A session's tail can run to megabytes; the default cap is 1MB.
        t.maximumMessageSize = 64 << 20
        task = t
        onState(.connecting)
        t.resume()
        Task { await run(t, gen) }
    }

    private func run(_ t: URLSessionWebSocketTask, _ gen: Int) async {
        do {
            let hello = try JSONEncoder().encode(["v": JSON(serveProtocol), "token": .string(token)])
            try await t.send(.string(String(decoding: hello, as: UTF8.self)))
            let welcome = try await receive(t)
            if let err = try JSONDecoder().decode(Head.self, from: welcome).err {
                throw DrayError(err.message)
            }
            guard gen == generation else { return }
            dictation = (try? JSONDecoder().decode(Welcome.self, from: welcome))?.dictation ?? false
            connected = true
            retry = 1
            onState(.connected)
            Task { await ping(t, gen) }
            while true {
                let data = try await receive(t)
                guard gen == generation else { return }
                route(data)
            }
        } catch {
            guard gen == generation else { return }
            drop(error.localizedDescription)
            onState(.failed(error.localizedDescription))
            try? await Task.sleep(for: .seconds(retry))
            retry = min(retry * 2, 15)
            if gen == generation { connect() }
        }
    }

    /// Keeps the tunnel from idling the socket out, and finds a dead one: a
    /// failed ping cancels the task, which ends the receive loop and reconnects.
    private func ping(_ t: URLSessionWebSocketTask, _ gen: Int) async {
        while gen == generation {
            try? await Task.sleep(for: .seconds(25))
            if gen == generation {
                t.sendPing { error in if error != nil { t.cancel(with: .goingAway, reason: nil) } }
            }
        }
    }

    private func receive(_ t: URLSessionWebSocketTask) async throws -> Data {
        switch try await t.receive() {
        case .string(let s): return Data(s.utf8)
        case .data(let d): return d
        @unknown default: throw DrayError("Unreadable frame")
        }
    }

    private func route(_ data: Data) {
        guard let head = try? JSONDecoder().decode(Head.self, from: data) else { return }
        if let id = head.id {
            waiting.removeValue(forKey: id)?.resume(returning: data)
        } else if let event = head.event {
            onEvent(event, data)
        }
    }

    /// Fails every call waiting on a socket that is gone, so nothing hangs.
    private func drop(_ reason: String) {
        connected = false
        let pending = waiting
        waiting = [:]
        for (_, c) in pending { c.resume(throwing: DrayError(reason)) }
    }

    /// Calls a server command, with arguments named as the desktop's `invoke` names them.
    /// `timeout` is how long a silent socket may hold the call.
    func call<T: Decodable>(_ cmd: String, _ args: [String: JSON] = [:], as: T.Type = T.self, timeout: Duration = .seconds(60)) async throws -> T {
        guard connected, let t = task else { throw DrayError("Not connected") }
        let id = nextId
        nextId += 1
        let frame = try JSONEncoder().encode(Call(id: id, cmd: cmd, args: args))
        let data = try await withCheckedThrowingContinuation { (c: CheckedContinuation<Data, Error>) in
            waiting[id] = c
            t.send(.string(String(decoding: frame, as: UTF8.self))) { error in
                guard let error else { return }
                Task { @MainActor in self.waiting.removeValue(forKey: id)?.resume(throwing: error) }
            }
            // A socket that stops answering without closing would otherwise hold the call forever.
            Task { @MainActor in
                try? await Task.sleep(for: timeout)
                self.waiting.removeValue(forKey: id)?.resume(throwing: DrayError("The server took too long to answer \(cmd)"))
            }
        }
        return try JSONDecoder().decode(Reply<T>.self, from: data).ok
    }
}

/// An address as a reader types it — `host:port`, `http(s)://`, `ws(s)://` —
/// as the URL the socket opens; `servers.rs`'s reading.
func socketURL(_ text: String) -> URL? {
    let s = text.trimmingCharacters(in: .whitespaces)
    let url: String
    if s.hasPrefix("http://") { url = "ws://" + s.dropFirst(7) }
    else if s.hasPrefix("https://") { url = "wss://" + s.dropFirst(8) }
    else if s.hasPrefix("ws://") || s.hasPrefix("wss://") { url = s }
    else { url = "ws://" + s }
    guard let u = URL(string: url), u.host != nil else { return nil }
    return u
}

/// A connect line is `<address> <64-hex token>`, what `dray server tunnel on` prints.
func parseConnectLine(_ text: String) -> (url: String, token: String)? {
    let parts = text.split(whereSeparator: \.isWhitespace).map(String.init)
    guard parts.count == 2, parts[1].count == 64, parts[1].allSatisfy(\.isHexDigit) else { return nil }
    return (parts[0], parts[1])
}
