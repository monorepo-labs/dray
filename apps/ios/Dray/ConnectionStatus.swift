import SwiftUI
import ThinkingOrbs

/// What to say about one server that is not simply working: a line, a reason,
/// and the one thing to do about it. Every surface that names a server's
/// state reads it from here, so the list, a session and Settings agree.
struct Health {
    enum Action { case retry, fix }
    let title: String
    let detail: String?
    /// When it tries again on its own; the detail counts down to it.
    var until: Date?
    var action: Action?
    /// The reader has to do something, rather than wait: drawn in the yellow.
    var needsYou = false
    var symbol = "exclamationmark.triangle"
    /// Already trying again, so an orb says so instead of a symbol.
    var working = false
}

extension Store {
    /// Nil while the server is fine, or still on its first try, which is
    /// quick and would only flash. Offline is said once for every server.
    func health(_ id: UUID) -> Health? {
        let name = name(of: id)
        switch serverState[id] {
        case .connected?:
            return loadErrors[id].map {
                Health(title: "Couldn't load sessions from \(name)", detail: sentence($0), action: .retry)
            }
        case .connecting(let attempt)?:
            return attempt == 0 || !online ? nil
                : Health(title: "Reconnecting to \(name)", detail: nil, working: true)
        case .waiting(let problem, let until)?:
            if !online || problem == .offline { return nil }
            return Health(title: "Can't reach \(name)", detail: nil, until: until, action: .retry, symbol: "bolt.horizontal.circle")
        case .failed(let problem)?:
            switch problem {
            case .auth:
                return Health(title: "\(name) refused the token",
                              detail: "Pair this phone again, or paste a new token.",
                              action: .fix, needsYou: true, symbol: "key")
            case .serverOlder:
                return Health(title: "\(name) needs an update",
                              detail: "It runs an older dray-serve than this app speaks. Run dray update there, then retry.",
                              action: .retry, needsYou: true, symbol: "arrow.down.circle")
            case .serverNewer:
                return Health(title: "This app needs an update",
                              detail: "\(name) is newer than this app. Update Dray from TestFlight, then retry.",
                              action: .retry, needsYou: true, symbol: "arrow.down.circle")
            case .badAddress:
                return Health(title: "\(name) has no valid address",
                              detail: "Remove it and add it again.", action: .fix, needsYou: true, symbol: "link")
            case .offline, .unreachable, .other:
                return Health(title: "Can't reach \(name)", detail: nil, action: .retry, symbol: "bolt.horizontal.circle")
            }
        case nil:
            return nil
        }
    }

    /// One server's state in a word or two, for its row in Settings.
    func stateLabel(_ id: UUID) -> String {
        switch serverState[id] {
        case .connected?: "Connected"
        case .connecting(0)?, nil: "Connecting…"
        case .connecting?: "Reconnecting…"
        case .waiting?: online ? "Can't reach it" : "Offline"
        case .failed(.auth)?: "Token refused"
        case .failed(.serverOlder)?: "Server needs an update"
        case .failed(.serverNewer)?: "App needs an update"
        case .failed(.badAddress)?: "Invalid address"
        case .failed?: "Can't reach it"
        }
    }
}

/// A server error opens lowercase, written to follow a colon; a sentence here
/// stands on its own.
func sentence(_ s: String) -> String {
    s.prefix(1).uppercased() + s.dropFirst()
}

/// "Trying again in 8s", counting down to `until`, then "Trying again…".
struct Countdown: View {
    let until: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = Int(until.timeIntervalSince(context.date).rounded(.up))
            Text(left > 0 ? "Trying again in \(left)s" : "Trying again…")
                .monospacedDigit()
                .contentTransition(.numericText(countsDown: true))
                .animation(.snappy, value: left)
        }
    }
}

/// One server's trouble, at the top of the list. Each server gets its own, so
/// one failing never hides another working.
struct ServerBanner: View {
    let name: String
    let health: Health
    let retry: () -> Void
    let fix: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: Theme.Space.m) {
            Group {
                if health.working {
                    Orb(.reconnecting)
                } else {
                    Image(systemName: health.symbol)
                        .font(.body.weight(.medium))
                        .foregroundStyle(health.needsYou ? Theme.accent : Theme.secondary)
                }
            }
            .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(health.title)
                    .font(Theme.Font.callout.weight(.semibold))
                    .foregroundStyle(Theme.text)
                Group {
                    if let detail = health.detail { Text(detail) }
                    if let until = health.until { Countdown(until: until) }
                }
                .font(Theme.Font.meta)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if let action = health.action {
                Button(action == .fix ? "Fix" : "Retry") {
                    Haptic.tap()
                    action == .fix ? fix() : retry()
                }
                .font(Theme.Font.callout.weight(.semibold))
                .buttonStyle(.borderless)
                .foregroundStyle(health.needsYou ? Theme.accent : Theme.text)
            }
        }
        .card(padding: Theme.Space.m)
        .padding(.vertical, Theme.Space.xs)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}

/// No network at all: said once, in place of every server's own banner.
struct OfflineBanner: View {
    var body: some View {
        HStack(spacing: Theme.Space.m) {
            Image(systemName: "wifi.slash")
                .font(.body.weight(.medium))
                .foregroundStyle(Theme.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text("You're offline").font(Theme.Font.callout.weight(.semibold)).foregroundStyle(Theme.text)
                Text("Sessions keep running on their servers. This reconnects when the network is back.")
                    .font(Theme.Font.meta).foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .card(padding: Theme.Space.m)
        .padding(.vertical, Theme.Space.xs)
    }
}

/// A session's server, when it is not connected: a slim line above the
/// composer, so the reader knows why Send is off before pressing it.
struct ConnectionStrip: View {
    @Environment(Store.self) private var store
    let server: UUID
    var openSettings: () -> Void = {}

    var body: some View {
        let state = store.serverState[server]
        if state != .connected {
            let health = store.health(server)
            HStack(spacing: Theme.Space.s) {
                if !store.online {
                    Image(systemName: "wifi.slash").foregroundStyle(Theme.secondary)
                    Text("You're offline").foregroundStyle(Theme.secondary)
                    Spacer(minLength: 0)
                } else if let health, !health.working {
                    Image(systemName: health.symbol).foregroundStyle(health.needsYou ? Theme.accent : Theme.secondary)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(health.title).foregroundStyle(Theme.text).lineLimit(1)
                        if let until = health.until { Countdown(until: until).foregroundStyle(Theme.secondary) }
                    }
                    Spacer(minLength: 0)
                    if let action = health.action {
                        Button(action == .fix ? "Fix" : "Retry") {
                            if action == .fix { openSettings() } else { Task { await store.retry(server) } }
                        }
                        .fontWeight(.semibold)
                        .foregroundStyle(health.needsYou ? Theme.accent : Theme.text)
                    }
                } else {
                    Orb(.reconnecting, size: 16)
                    Text("Connecting to \(store.name(of: server))…").foregroundStyle(Theme.secondary)
                    Spacer(minLength: 0)
                }
            }
            .font(Theme.Font.meta)
            .padding(.horizontal, Theme.Space.m)
            .padding(.vertical, Theme.Space.s)
            .background(.ultraThinMaterial, in: .rect(cornerRadius: Theme.Radius.md, style: .continuous))
            .padding(.horizontal, Theme.Space.m)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// An action that failed with nowhere of its own to say so — a card's answer,
/// a Stop — drawn over the top of the screen for a moment, never an alert.
struct ErrorToast: View {
    @Environment(Store.self) private var store

    var body: some View {
        ZStack {
            if let message = store.lastError {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.destructive)
                    Text(sentence(message)).foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(Theme.Font.callout)
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, Theme.Space.m)
                .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous).strokeBorder(Theme.border))
                .shadow(color: .black.opacity(0.5), radius: 16, y: 6)
                .padding(.horizontal, Theme.Space.l)
                .onTapGesture { store.lastError = nil }
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: message) {
                    Haptic.error()
                    try? await Task.sleep(for: .seconds(4))
                    store.lastError = nil
                }
            }
        }
        .animation(Theme.motion, value: store.lastError)
    }
}
