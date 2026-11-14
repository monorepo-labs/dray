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
    /// An icon from the asset catalog, else an SF Symbol.
    var symbol = "exclamationmark.triangle"
    /// Already trying again, so an orb says so instead of a symbol.
    var working = false
}

extension Health {
    /// No network at all, said once in place of each server's own trouble.
    static func offline(_ detail: String) -> Health {
        Health(title: "You're offline", detail: detail, symbol: "health-offline")
    }
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
                : Health(title: "Reconnecting to \(name)…", detail: nil, working: true)
        case .waiting(let problem, let until)?:
            if !online || problem == .offline { return nil }
            return Health(title: "Can't reach \(name)", detail: nil, until: until, action: .retry, symbol: "health-unreachable")
        case .failed(let problem)?:
            switch problem {
            case .auth:
                return Health(title: "\(name) refused the token",
                              detail: "Pair this phone again, or paste a new token.",
                              action: .fix, needsYou: true, symbol: "health-key")
            case .serverOlder:
                return Health(title: "\(name) needs an update",
                              detail: "Run dray update there, then retry.",
                              action: .retry, needsYou: true, symbol: "health-update")
            case .serverNewer:
                return Health(title: "This app needs an update",
                              detail: "\(name) is newer than this app. Update Dray from TestFlight, then retry.",
                              action: .retry, needsYou: true, symbol: "health-update")
            case .badAddress:
                return Health(title: "\(name) has no valid address",
                              detail: "Remove it and add it again.", action: .fix, needsYou: true, symbol: "health-unreachable")
            case .offline, .unreachable, .other:
                return Health(title: "Can't reach \(name)", detail: nil, action: .retry, symbol: "health-unreachable")
            }
        case nil:
            return nil
        }
    }

    /// One server's state in a word or two, for its row in Settings.
    func stateLabel(_ id: UUID) -> String {
        if servers.first(where: { $0.id == id })?.on == false { return "Off" }
        return switch serverState[id] {
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

/// One server's trouble, or the network's: what it is, why, and its one action.
/// `floating` is the session's, laid over the transcript under the title bar;
/// otherwise a card at the top of the list, one per server.
struct HealthBanner: View {
    let health: Health
    var floating = false
    var retry: () -> Void = {}
    var fix: () -> Void = {}

    var body: some View {
        HStack(spacing: 10) {
            Group {
                if health.working {
                    Orb(.reconnecting, size: 20)
                } else {
                    icon.resizable().scaledToFit()
                        .foregroundStyle(health.needsYou ? Theme.accent : Theme.secondary)
                }
            }
            .frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(health.title).font(Theme.Font.subhead).foregroundStyle(Theme.text)
                Group {
                    if let detail = health.detail { Text(detail) }
                    if let until = health.until { Countdown(until: until) }
                }
                .font(Theme.Font.footnote)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let action = health.action {
                Button(action == .fix ? "Fix" : "Retry") {
                    Haptic.tap()
                    action == .fix ? fix() : retry()
                }
                .font(Theme.Font.pill)
                .buttonStyle(.borderless)
                .foregroundStyle(health.needsYou ? Theme.accent : Theme.text)
            }
        }
        .padding(.vertical, floating ? Theme.Space.s : Theme.Space.m)
        .padding(.horizontal, 14)
        // Small over a session: a note, not a wall between the reader and the transcript.
        .frame(minHeight: floating ? 0 : 64)
        .background { if floating { glass } else { RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous).fill(Theme.card) } }
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var icon: Image {
        UIImage(named: health.symbol) != nil ? Image(health.symbol) : Image(systemName: health.symbol)
    }

    private var glass: some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        return shape.fill(.ultraThinMaterial)
            .overlay(shape.fill(Theme.raised.opacity(0.9)))
            .overlay(shape.strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.6), radius: 12, y: 8)
    }
}

/// A session's server when it is not connected, floating under the title bar so the
/// reader knows why the dock is dim before holding the orb.
struct SessionBanner: View {
    @Environment(Store.self) private var store
    let server: UUID
    let fix: () -> Void

    var body: some View {
        // Only once the server is really lost: a reconnect after the app comes back says nothing.
        Group {
            if !store.lost.contains(server) {
                EmptyView()
            } else if !store.online {
                HealthBanner(health: .offline("The task keeps running on \(store.name(of: server))."), floating: true)
            } else if let health = store.health(server) {
                HealthBanner(health: health, floating: true, retry: { Task { await store.retry(server) } }, fix: fix)
            }
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.top, 10)
        .animation(Theme.motion, value: store.lost.contains(server))
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
                .font(Theme.Font.subhead)
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
                    // Cancelled by a newer message, which is not this task's to clear.
                    do { try await Task.sleep(for: .seconds(4)) } catch { return }
                    if store.lastError == message { store.lastError = nil }
                }
            }
        }
        .animation(Theme.motion, value: store.lastError)
    }
}
