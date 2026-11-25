import AVKit
import SwiftUI

// A bot's attachments and routines, under its tasks: the desktop More tab's
// two bot sections (AttachmentsPanel.tsx, RoutinesSection.tsx), on its calls.

// MARK: Attachments

/// One picture or recording in a bot's chat.
struct Attachment: Identifiable {
    let image: ImageRef?
    let video: String?
    let byYou: Bool
    let at: String?
    let name: String
    var id: String { video ?? image?.path ?? image?.url ?? "" }
}

/// A kept copy is named by its id, which says nothing on a row.
private let archivedName = #/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(-\d+)?\.\w+$/#
/// The desktop's `RECORD_STOP`: a call whose result names the recording it made.
private let recordStop = #/(?:^|[;&|(\n]|\s-\w*c\s+['"])\s*dray\s+(?:browser\s+record\s+stop|video\s+add)\b/#

/// The desktop's `sessionMedia` over a page of events, newest first. `named` holds
/// the held chat's own events, whose calls name the file a tool read a picture from:
/// `list_attachments` sends only the lines carrying media.
func attachments(_ events: [AgentEvent], named: [AgentEvent] = []) -> [Attachment] {
    var readFrom: [String: String] = [:]
    var stops: Set<String> = []
    for e in named + events {
        guard case .toolStarted(let callId, _, _, let input, _) = e.payload else { continue }
        if let path = (input["file_path"] ?? input["path"])?.string, let file = path.split(separator: "/").last {
            readFrom[callId] = String(file)
        }
        if case .object(let o) = input, o.values.contains(where: { $0.string?.contains(recordStop) == true }) {
            stops.insert(callId)
        }
    }
    func label(_ file: String?, video: Bool) -> String {
        guard let file, !file.isEmpty, (try? archivedName.wholeMatch(in: file)) == nil else { return video ? "Recording" : "Image" }
        return file
    }
    func images(_ list: [ImageRef], byYou: Bool, at: String?, from: String? = nil) -> [Attachment] {
        list.map { ref in
            let file = from ?? (ref.path ?? ref.url).flatMap { $0.hasPrefix("data:") ? nil : $0.split(separator: "/").last.map(String.init) }
            return Attachment(image: ref, video: nil, byYou: byYou, at: at, name: label(file, video: false))
        }
    }
    func videos(_ text: String, at: String?) -> [Attachment] {
        recordingPaths(in: text).map { Attachment(image: nil, video: $0, byYou: false, at: at, name: label($0.split(separator: "/").last.map(String.init), video: true)) }
    }
    var out: [Attachment] = []
    for e in events where e.subagent == nil || e.subagent == .null {
        switch e.payload {
        // A relayed send arrives as a user message too, but another session sent it.
        case .userMessage(_, let title, let id, _, let list, _, let bot):
            out += images(list, byYou: title == nil && id == nil && bot == nil, at: e.ts)
        case .toolCompleted(let callId, let result):
            out += images(result.images, byYou: false, at: e.ts, from: result.images.count == 1 ? readFrom[callId] : nil)
            if stops.contains(callId) { out += videos(result.text, at: e.ts) }
        case .assistantText(let text):
            out += videos(text, at: e.ts)
        default: break
        }
    }
    var seen = Set<String>()
    return out.reversed().filter { !$0.id.isEmpty && seen.insert($0.id).inserted }
}

/// How many the list opens on, and how many each Load more adds.
private let attachmentsPage = 10

/// Every picture and recording in a bot's chat as a list, newest first: a thumbnail,
/// its name, who sent it and when. A picture opens the image viewer paging through the
/// list's pictures; a recording plays in AVKit's own full screen player. Drawn only
/// once there is one, as every section under the tasks is.
struct BotAttachments: View {
    @Environment(Store.self) private var store
    @Environment(\.imageServer) private var server
    /// The bot's chat, newest session first.
    let chat: [SessionKey]
    @State private var items: [Attachment] = []
    /// Per session, where its next page ends; absent reads from the end.
    @State private var cursors: [String: Int] = [:]
    /// Sessions read to their start.
    @State private var done: Set<String> = []
    /// How many rows show: a page holds whole turns, so a read can bring more than asked.
    @State private var count = attachmentsPage
    @State private var loading = false
    @State private var failed = false
    /// The first page is in, so a new message reads only the newest one again.
    @State private var loaded = false
    @State private var filter: Bool?
    @State private var gallery: Gallery?

    var body: some View {
        let mixed = items.contains(where: \.byYou) && items.contains { !$0.byYou }
        let filtered = matching(items)
        let shown = Array(filtered.prefix(count))
        let more = filtered.count > count || chat.contains { !done.contains($0.id) }
        let up = server.map { store.serverState[$0.serverId] == .connected } ?? false
        let newest = chat.first.flatMap { store.transcripts[$0]?.events.last?.id } ?? ""
        VStack(alignment: .leading, spacing: 0) {
            if !items.isEmpty || failed {
                HStack(spacing: Theme.Space.m) {
                    Text("Attachments").frame(maxWidth: .infinity, alignment: .leading)
                    if mixed {
                        ForEach([("All", nil), ("You", true), ("AI", false)] as [(String, Bool?)], id: \.0) { label, value in
                            Button(label) { filter = value }
                                .foregroundStyle(filter == value ? Theme.text : Theme.secondary)
                                .accessibilityAddTraits(filter == value ? .isSelected : [])
                        }
                    }
                }
                .sectionHeading()
                ForEach(shown) { row($0, in: shown) }
                if more || failed { loadMore }
            }
        }
        // Again on each new event in the chat, and on a reconnect: a first read that failed
        // is tried again, and one that worked picks up what the bot sent since.
        .task(id: "\(chat.first?.id ?? "")|\(newest)|\(up)") { if loaded { await readNewest() } else { await fill() } }
        .imageViewer($gallery)
    }

    /// The list under the picked filter; the filters show only where both sides are there.
    private func matching(_ list: [Attachment]) -> [Attachment] {
        let mixed = list.contains(where: \.byYou) && list.contains { !$0.byYou }
        return list.filter { !mixed || filter == nil || $0.byYou == filter }
    }

    private func row(_ item: Attachment, in shown: [Attachment]) -> some View {
        Button { open(item, in: shown) } label: {
            HStack(spacing: 10) {
                Group {
                    if let ref = item.image {
                        RemoteImage(ref: ref, fill: true)
                    } else {
                        Theme.raised.overlay { Image(systemName: "play.fill").font(.system(size: 12)).foregroundStyle(Theme.secondary) }
                    }
                }
                .frame(width: 36, height: 36)
                .clipShape(.rect(cornerRadius: Theme.Radius.sm, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.name).font(Theme.Font.body).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle)
                    // The filters' own words, so a row says which one it falls under.
                    Text(item.byYou ? "You" : item.video != nil ? "AI · Recording" : "AI")
                        .font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                }
                Spacer(minLength: 0)
                if let date = item.at.flatMap(parseDate) {
                    Text(shortAge(date)).font(Theme.Font.footnote.font.monospacedDigit()).foregroundStyle(Theme.tertiary)
                }
            }
            .padding(.horizontal, Theme.Space.m)
            .frame(minHeight: 52)
        }
        .buttonStyle(RowButtonStyle())
        .accessibilityLabel("\(item.video == nil ? "Open" : "Play") \(item.name)")
        .accessibilityIdentifier("attachmentRow")
    }

    /// The runs list's Load more, in the marks' column.
    private var loadMore: some View {
        Button {
            // A retry reads the page that failed rather than asking for one more.
            if !failed { count += attachmentsPage }
            Task { await fill() }
        } label: {
            HStack(spacing: 10) {
                Group {
                    if loading { ProgressView().controlSize(.small) } else { Image(systemName: "plus") }
                }
                .frame(width: 36, height: 22)
                Text(loading ? "Loading…" : failed ? "Couldn't load \(items.isEmpty ? "attachments" : "more"). Try again" : "Load more")
                Spacer(minLength: 0)
            }
            .font(Theme.Font.subhead)
            .foregroundStyle(Theme.secondary)
            .padding(.horizontal, Theme.Space.m)
            .frame(height: 44)
        }
        .buttonStyle(RowButtonStyle())
        .disabled(loading)
    }

    private func open(_ item: Attachment, in shown: [Attachment]) {
        if let path = item.video {
            if let server, let url = recordingURL(path, on: server) { playFullScreen(url) }
            return
        }
        let pictures = shown.filter { $0.image != nil }
        guard let start = pictures.firstIndex(where: { $0.id == item.id }) else { return }
        let shots = pictures.compactMap { p in p.image.map { Shot(ref: $0, verb: p.byYou ? "Attached" : "Image", target: p.name) } }
        instantly { gallery = Gallery(shots: shots, start: start) }
    }

    /// Reads back, newest session first, until `count` rows match the filter or every log is read.
    private func fill() async {
        guard !loading, !chat.isEmpty else { return }
        loading = true
        failed = false
        defer { loading = false }
        var seen = Set(items.map(\.id))
        do {
            for key in chat where !done.contains(key.id) {
                while matching(items).count < count, !done.contains(key.id) {
                    let page = try await page(key, before: cursors[key.id])
                    items += try await read(page, in: key).filter { seen.insert($0.id).inserted }
                    if let next = page.olderBefore { cursors[key.id] = next } else { done.insert(key.id) }
                }
                if matching(items).count >= count { break }
            }
            loaded = true
        } catch {
            failed = true
        }
    }

    /// The newest page of the newest session, ahead of the rest: what arrived since the list was read.
    private func readNewest() async {
        guard !loading, let key = chat.first,
              let page = try? await page(key, before: nil),
              let read = try? await read(page, in: key) else { return }
        let seen = Set(items.map(\.id))
        let fresh = read.filter { !seen.contains($0.id) }
        items.insert(contentsOf: fresh, at: 0)
        count += fresh.count
    }

    /// The media lines written before `before`, or from the end of the log.
    private func page(_ key: SessionKey, before: Int?) async throws -> Snapshot {
        // Under 1e15, which `JSON` still sends as an integer: the server reads up to the file's end.
        try await store.call(key.server, "list_attachments", [
            "sessionId": .string(key.id), "before": JSON(before ?? 999_999_999_999_999), "limit": JSON(attachmentsPage),
        ])
    }

    private func read(_ page: Snapshot, in key: SessionKey) async throws -> [Attachment] {
        let held = chat.flatMap { store.transcripts[$0]?.events ?? [] }
        return attachments(page.events, named: held + (await calls(of: page.events, in: key)))
    }

    /// The calls that handed back a picture: a bot chat is read without its tool calls
    /// (`bot: true`), and a call's input is what names the file it read. None is no name.
    private func calls(of events: [AgentEvent], in key: SessionKey) async -> [AgentEvent] {
        let ids = events.compactMap { e -> JSON? in
            guard case .toolCompleted(let id, let result) = e.payload, !result.images.isEmpty else { return nil }
            return .string(id)
        }
        guard !ids.isEmpty else { return [] }
        return (try? await store.call(key.server, "get_session_calls", ["sessionId": .string(key.id), "callIds": .array(ids)])) ?? []
    }
}

/// AVKit's own full screen player over whatever is up, closed by its X: the transcript's full screen.
@MainActor private func playFullScreen(_ url: URL) {
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
    guard var top = scene?.keyWindow?.rootViewController else { return }
    while let next = top.presentedViewController { top = next }
    let controller = AVPlayerViewController()
    controller.player = AVPlayer(url: url)
    controller.modalPresentationStyle = .fullScreen
    top.present(controller, animated: true) { controller.player?.play() }
}

// MARK: Routines

/// A bot's scheduled check, as `list_routines` answers it.
struct Routine: Decodable, Identifiable {
    struct Schedule: Decodable {
        let everyMinutes: Int?
        let at: String?
        let days: [Int]?
    }
    let id: String
    let name: String
    let schedule: Schedule
    var paused: Bool
    let nextRun: String?

    /// "Every 2h", "Weekdays at 09:00": the desktop's `scheduleLabel`.
    var scheduleLabel: String {
        if let m = schedule.everyMinutes, m > 0 {
            return "Every " + (m % 1440 == 0 ? "\(m / 1440)d" : m % 60 == 0 ? "\(m / 60)h" : "\(m)m")
        }
        let days = Set(schedule.days ?? []).filter { (0..<7).contains($0) }.sorted()
        let names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        let when = switch days {
        case [], [0, 1, 2, 3, 4, 5, 6]: "Daily"
        case [0, 1, 2, 3, 4]: "Weekdays"
        case [5, 6]: "Weekends"
        default: days.map { names[$0] }.joined(separator: ", ")
        }
        return "\(when) at \(schedule.at ?? "?")"
    }

    /// "Paused", "Next in 34m", "Next 9:00 AM tomorrow" or "Due now": the desktop's `nextRunLabel`.
    func nextLabel(_ now: Date) -> String {
        if paused { return "Paused" }
        guard let at = nextRun.flatMap(parseDate) else { return "Not scheduled" }
        let min = Int((at.timeIntervalSince(now) / 60).rounded())
        if min <= 0 { return "Due now" }
        if min < 60 { return "Next in \(min)m" }
        let time = at.formatted(date: .omitted, time: .shortened)
        let cal = Calendar.current
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: at)).day ?? 0
        if days <= 0 { return "Next \(time)" }
        if days == 1 { return "Next \(time) tomorrow" }
        return "Next \(time) on \(at.formatted(.dateTime.month(.abbreviated).day()))"
    }
}

/// A bot's routines, as on desktop: each with its schedule and next run.
/// The switch turns one off and on; Delete is in the long-press menu. Anything else —
/// running it now, changing it — the reader asks the bot for. Drawn only with one in it.
struct BotRoutines: View {
    @Environment(Store.self) private var store
    let server: UUID
    let botId: String
    @State private var routines: [Routine] = []
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !routines.isEmpty {
                Text("Routines").frame(maxWidth: .infinity, alignment: .leading).sectionHeading()
                if let error {
                    Text(error).font(Theme.Font.footnote).foregroundStyle(Theme.destructive)
                        .padding(.horizontal, Theme.Space.m).padding(.bottom, Theme.Space.xs)
                }
                // "Next in" counts down, so the rows are read against a clock that ticks each minute.
                TimelineView(.everyMinute) { tick in
                    VStack(spacing: 0) { ForEach(routines) { row($0, now: tick.date) } }
                }
            }
        }
        // On every `routines_changed`, on a reconnect, which may have missed one, and once
        // a minute as the desktop does, so a read that failed is tried again.
        .task(id: "\(store.routinesRevision)|\(store.serverState[server] == .connected)") {
            while !Task.isCancelled {
                await read()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    private func row(_ r: Routine, now: Date) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "clock").font(.system(size: 15)).foregroundStyle(Theme.secondary)
                .opacity(r.paused ? 0.5 : 1).frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(r.name).font(Theme.Font.body).foregroundStyle(r.paused ? Theme.secondary : Theme.text).lineLimit(1)
                Text("\(r.scheduleLabel) · \(r.nextLabel(now))").font(Theme.Font.footnote).foregroundStyle(Theme.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Toggle("", isOn: Binding(get: { !r.paused }, set: { on in Task { await setPaused(r, !on) } }))
                .toggleStyle(SwitchStyle())
                .fixedSize()
                .accessibilityLabel(r.paused ? "Turn on \(r.name)" : "Turn off \(r.name)")
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.s)
        .contentShape(.rect)
        .contextMenu {
            Button("Delete routine", systemImage: "trash", role: .destructive) { Task { await remove(r) } }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("routineRow")
    }

    private func read() async {
        guard let list = try? await store.call(server, "list_routines", ["botId": .string(botId)], as: [Routine].self) else { return }
        routines = list
    }

    /// The switch moves at once and goes back where the server refused, or never answered.
    private func setPaused(_ r: Routine, _ paused: Bool) async {
        let set = { (to: Bool) in if let i = routines.firstIndex(where: { $0.id == r.id }) { routines[i].paused = to } }
        set(paused)
        let ok = await act("set_routine_paused", ["id": .string(r.id), "paused": .bool(paused)], paused ? "Couldn't pause it" : "Couldn't resume it")
        if !ok { set(r.paused) }
    }

    private func remove(_ r: Routine) async {
        _ = await act("delete_routine", ["id": .string(r.id)], "Couldn't delete it")
    }

    /// One that fails leaves its reason until the next succeeds; the list is read again either way.
    @discardableResult
    private func act(_ cmd: String, _ args: [String: JSON], _ failed: String) async -> Bool {
        do {
            let _: JSON = try await store.call(server, cmd, args)
            error = nil
            Haptic.tap()
            await read()
            return true
        } catch {
            self.error = "\(failed): \(sentence(error.localizedDescription))"
            Haptic.error()
            await read()
            return false
        }
    }
}

private extension View {
    /// The runs list's section heading, so these read as two more of its sections.
    func sectionHeading() -> some View {
        font(Theme.Font.footnote)
            .foregroundStyle(Theme.secondary)
            .padding(.horizontal, Theme.Space.m)
            .padding(.top, Theme.Space.l)
            .padding(.bottom, Theme.Space.xs)
    }
}
