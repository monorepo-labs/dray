import SwiftUI
import ThinkingOrbs

/// What a session's row says about it, the desktop sidebar's marks: the rail
/// dot, the pull request, and what is in flight.
struct Marks: Equatable {
    var asking = false
    var unread = false
    var busy = false
    var pr: PrMark?

    var checksRunning: Bool { pr?.state == "OPEN" && pr?.checksState == "RUNNING" }
}

/// The sidebar's rail mark: yellow waits on the reader, green is finished and
/// unread. Dark mode's `--accent-command` and `--accent-add`, since the panel is always dark.
struct StatusDot: View {
    let marks: Marks
    static let waiting = Color(red: 0.897, green: 0.753, blue: 0.34)
    static let unread = Color(red: 0.036, green: 0.732, blue: 0.514)

    var body: some View {
        Rail(color: marks.asking ? Self.waiting : marks.unread ? Self.unread : .clear)
    }
}

/// A 2×6 bar in a fixed 8pt slot, so the title never moves when it comes and goes.
struct Rail: View {
    let color: Color

    var body: some View {
        RoundedRectangle(cornerRadius: 1).fill(color)
            .frame(width: 2, height: 6)
            .frame(width: 8)
    }
}

/// The one mark ahead of a title: running checks, else the turn working, else
/// the pull request. Each at its own width, so the title sits close behind it.
struct LeadMark: View {
    let marks: Marks
    /// Off where the title shimmers instead, which says the same.
    var orb = true
    @Environment(\.motionPaused) private var hidden

    var body: some View {
        if marks.checksRunning {
            ChecksSpinner()
        } else if marks.busy && orb {
            Orb(state: .working, size: 16, paused: hidden).foregroundStyle(.white.opacity(0.7))
        } else if let pr = marks.pr {
            PrGlyph(mark: pr, size: 13)
        }
    }

    var shown: Bool { marks.checksRunning || (marks.busy && orb) || marks.pr != nil }
}

/// The selected session's title row: the title opens the task list behind its
/// lead mark, ⌘-click opens the session in Dray, and the hints teach the keys.
struct TitleRow: View {
    let title: String
    /// Beside the title rather than in it, since a long title is cut and this must not be.
    var machine: String? = nil
    let marks: Marks
    /// A bot's chat: its face leads the name.
    var bot: Bot? = nil
    let close: String
    let list: () -> Void
    let openInApp: () -> Void
    /// A gesture to teach, ahead of the keys, until the reader has used it.
    var hint: String? = nil
    @State private var hovered = false

    var body: some View {
        HStack(spacing: 12) {
            Button {
                if NSEvent.modifierFlags.contains(.command) { openInApp() } else { list() }
            } label: {
                HStack(spacing: bot == nil ? 4 : 6) {
                    if let bot {
                        BotFace(bot: bot, size: 16)
                    } else {
                        let lead = LeadMark(marks: marks, orb: false)
                        if lead.shown { lead }
                    }
                    Text(bot?.name ?? title).lineLimit(1)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white.opacity(hovered ? 1 : 0.7))
                        .shimmer(marks.busy, period: 1.4)
                    if let machine {
                        Text(machine).font(.system(size: 13)).foregroundStyle(.white.opacity(0.4)).lineLimit(1).fixedSize()
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovered = $0 }
            .animation(.easeOut(duration: 0.12), value: hovered)
            .help("Tasks, ⌘-click to open in Dray")
            if let hint {
                Text(hint).font(.system(size: 12)).foregroundStyle(.white.opacity(0.3)).fixedSize()
                    .transition(.opacity)
            }
            KeyHints(new: true, close: close)
        }
    }
}

/// The panel's keys, dimmed. `close` is the composer's `closeHint`, since Esc
/// only reaches a panel holding the keys.
struct KeyHints: View {
    let new: Bool
    let close: String

    var body: some View {
        HStack(spacing: 10) {
            if new { Text("⌘N New") }
            Text("↑↓ Tasks")
            Text(close)
        }
        .font(.system(size: 12))
        .foregroundStyle(.white.opacity(0.3))
        .fixedSize()
    }
}

/// A task in the list, marked the way the desktop sidebar marks its rows.
struct SessionRow: View {
    let title: String
    let project: String
    let marks: Marks
    let selected: Bool
    /// A bot's chat: its face and name, and no project, which would be its folder's id.
    var bot: Bot? = nil
    @State private var hover = false
    static let height: CGFloat = 32

    var body: some View {
        HStack(spacing: 4) {
            if let bot {
                BotFace(bot: bot).padding(.trailing, 2)
                Text(bot.name).lineLimit(1)
                Spacer(minLength: 8)
                if marks.busy { TypingDots() }
            } else {
                let lead = LeadMark(marks: marks)
                if lead.shown { lead }
                Text(title.isEmpty ? "Untitled" : title).lineLimit(1)
                Spacer(minLength: 8)
                Text(project).lineLimit(1).foregroundStyle(.secondary)
            }
        }
        .font(.system(size: 13))
        .padding(.horizontal, 8)
        // In the padding at the row's edge, the sidebar's place, so the slot costs the title nothing.
        .overlay(alignment: .leading) { StatusDot(marks: marks) }
        .frame(height: Self.height)
        .background(selected ? .white.opacity(0.12) : hover ? .white.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }
}

/// Hangs from the notch while the panel is shut and sessions wait on the
/// reader, until every one is answered. Resting the pointer on it opens the
/// panel on the cards; a short dwell keeps a pointer passing by from doing so.
struct AttentionPill: View {
    let notch: Bool
    let notchHeight: CGFloat
    let count: Int
    var glowing = false
    let action: () -> Void
    @State private var dwell: Task<Void, Never>?

    var body: some View {
        Button(action: action) {
            PillShell(notch: notch, notchHeight: notchHeight, glow: glowing ? StatusDot.waiting : nil) {
                HStack(spacing: 8) {
                    Circle().fill(StatusDot.waiting).frame(width: 6, height: 6)
                    Text("\(count) \(count == 1 ? "task needs" : "tasks need") attention")
                        .font(.system(size: 13, weight: .semibold)).lineLimit(1)
                }
            }
        }
        .buttonStyle(.plain)
        .onHover { inside in
            dwell?.cancel()
            guard inside else { return }
            dwell = Task {
                try? await Task.sleep(for: .milliseconds(150))
                if !Task.isCancelled { action() }
            }
        }
    }
}

/// A boat sandbox about to auto-stop, with the way to give it more time. Stands
/// until extended, stopped or dismissed, since missing it costs running work.
struct BoatPill: View {
    let notch: Bool
    let notchHeight: CGFloat
    let alert: BoatAlert
    let refused: String?
    let extend: (Int) async -> Void
    let dismiss: () -> Void
    var glowing = false

    var body: some View {
        PillShell(notch: notch, notchHeight: notchHeight, glow: glowing ? StatusDot.waiting : nil) {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(alert.name) stops in").font(.system(size: 12)).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
                    .frame(maxWidth: .infinity)
                // Redrawn each second, or the count would stand still. White
                // outright: the pills' window takes the system's appearance.
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Text(alert.countdown).font(.system(size: 20, weight: .semibold).monospacedDigit())
                        .foregroundStyle(alert.urgent ? Color.red : .white)
                        .frame(maxWidth: .infinity)
                }
                BoatExtendChoices(size: 12, extend: extend, dismiss: dismiss)
                    .padding(.top, 2)
                if let refused {
                    Text(refused).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                        .frame(maxWidth: 300, alignment: .leading)
                }
            }
        }
    }
}

/// Extend by a length stepped in 30-minute steps from 2 hours, the app card's
/// own control: a stepper because the pills' window never takes the keys.
struct BoatExtendChoices: View {
    let size: CGFloat
    /// Minutes. Returns once the app has answered.
    let extend: (Int) async -> Void
    var dismiss: (() -> Void)? = nil
    @State private var minutes = 120
    @State private var extending = false

    var body: some View {
        HStack(spacing: 8) {
            step("minus", by: -30).disabled(extending || minutes <= 30)
            Text(Self.label(minutes)).font(.system(size: size, weight: .semibold).monospacedDigit())
                .foregroundStyle(.white).frame(minWidth: size * 4)
            step("plus", by: 30).disabled(extending || minutes >= 30 * 24 * 60)
            Spacer(minLength: 16)
            if let dismiss {
                Button("Dismiss", action: dismiss)
                    .buttonStyle(.plain)
                    .font(.system(size: size, weight: .medium))
                    .foregroundStyle(.white.opacity(0.5))
                    .help("Hide this warning. It comes back if the stop time changes.")
            }
            Button(extending ? "Extending…" : "Extend") {
                extending = true
                Task {
                    await extend(minutes)
                    extending = false
                }
            }
            .buttonStyle(.plain)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(.white.opacity(extending ? 0.55 : 1))
            .disabled(extending)
        }
    }

    /// "2h", "2h 30m", "30m".
    static func label(_ minutes: Int) -> String {
        let (h, m) = (minutes / 60, minutes % 60)
        return [h > 0 ? "\(h)h" : nil, m > 0 ? "\(m)m" : nil].compactMap { $0 }.joined(separator: " ")
    }

    private func step(_ symbol: String, by delta: Int) -> some View {
        Button { minutes += delta } label: { Image(systemName: symbol).font(.system(size: size - 2, weight: .semibold)) }
            .buttonStyle(.plain)
            .foregroundStyle(.white.opacity(0.7))
    }
}

/// Sessions finished, in place of Dray's banner, newest first. One names
/// itself and offers Open in app; several are a count that, under the pointer,
/// grows a row each, five tall and then scrolling. A title opens the island on it.
/// A bot's "waiting on you" grows its card's rows under the pointer, as the bot chat draws them;
/// several bots waiting are one pill counting every task, grouped under each bot.
struct DonePill: View {
    @Environment(Store.self) private var store
    /// `note` stands in for "Done": what a bot's tasks wait on, drawn yellow as the app's rail draws waiting.
    /// `rows` are those tasks, as the app's card had them when it raised the note.
    typealias Item = (key: SessionKey, title: String, note: String?, rows: [WaitingTask])
    let notch: Bool
    let notchHeight: CGFloat
    let items: [Item]
    var glowing = false
    let open: (SessionKey) -> Void
    let openInApp: (SessionKey) -> Void
    var openTask: (SessionKey, WaitingTask) -> Void = { _, _ in }
    /// Answers why it failed, or nil once landed.
    var merge: (SessionKey, WaitingTask, String) async -> String? = { _, _, _ in nil }
    var hover: (Bool) -> Void = { _ in }
    /// Grown under the pointer; the demo's snapshot draws it grown from the start.
    @State var expanded = false
    /// A card drawn on its merge confirm from the start, for the demo's snapshot.
    var confirming: String? = nil
    @State private var collapse: Task<Void, Never>?
    @State private var listHeight: CGFloat = 0
    private static let row: CGFloat = 26

    var body: some View {
        // Yellow wins where both apply, as on the app's rail.
        let waiting = items.contains { $0.note != nil }
        let tint = waiting ? StatusDot.waiting : StatusDot.unread
        let cards = items.contains { !$0.rows.isEmpty }
        PillShell(notch: notch, notchHeight: notchHeight, glow: glowing ? tint : nil) {
            // One structure, open or shut, so the pill grows rather than swapping layouts.
            VStack(alignment: .leading, spacing: cards ? 8 : 6) {
                HStack(spacing: 8) {
                    Circle().fill(tint).frame(width: 6, height: 6)
                    Text(Self.headline(items, waiting: waiting))
                        .font(.system(size: 13, weight: .semibold))
                        // White outright: the pills' window takes the system's appearance, and light mode drew it black.
                        .foregroundStyle(.white)
                    // Several are a count alone; their titles wait for the pointer.
                    if items.count == 1, let first = items.first {
                        // A note takes the room "Done" left, so the title gives it back to fit the pill's window.
                        DoneTitle(title: first.title, cap: first.note == nil ? 240 : 160)
                        OpenInAppButton(chord: true) { openInApp(first.key) }
                    }
                }
                // Centred over the grown list, so its margins match the cards'.
                .frame(maxWidth: expanded && cards ? .infinity : nil)
                .contentShape(Rectangle())
                .onTapGesture { if let first = items.first { open(first.key) } }
                if expanded {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(items, id: \.key) { item in
                                // One item's own line is the pill's header already.
                                if items.count > 1 {
                                    if item.rows.isEmpty { line(item) } else { group(item) }
                                }
                                ForEach(item.rows, id: \.id) { task in
                                    WaitingCard(task: task, open: { openTask(item.key, task) }, merge: { await merge(item.key, task, $0) },
                                                confirming: confirming == task.id)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        // Cards differ in height, so the list is measured rather than counted.
                        .onGeometryChange(for: CGFloat.self, of: \.size.height) { listHeight = $0 }
                    }
                    .scrollIndicators(.never)
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(height: cards ? min(listHeight, 420) : CGFloat(min(items.count, 5)) * Self.row)
                    .transition(.opacity)
                }
            }
            .frame(width: expanded ? (cards ? 440 : 360) : nil, alignment: .leading)
        }
        .onHover { inside in
            hover(inside)
            collapse?.cancel()
            guard items.count > 1 || cards else { return }
            if inside {
                withAnimation(.spring(duration: 0.3, bounce: 0.12)) { expanded = true }
            } else {
                // A beat before shutting, so a pointer grazing the edge it just grew past does not flicker it.
                collapse = Task {
                    try? await Task.sleep(for: .milliseconds(150))
                    guard !Task.isCancelled else { return }
                    withAnimation(.spring(duration: 0.25, bounce: 0)) { expanded = false }
                }
            }
        }
    }

    /// What one item says: its rows counted while it has them, so a merge here moves the count.
    private static func headline(_ item: Item) -> String {
        let n = item.rows.count
        return n > 0 ? "\(n) \(n == 1 ? "task" : "tasks") waiting on you" : item.note ?? "Done"
    }

    /// The pill's own line: one item's, every bot's waiting tasks counted as one, else how many updates.
    private static func headline(_ items: [Item], waiting: Bool) -> String {
        if items.count == 1 { return headline(items[0]) }
        if items.allSatisfy({ !$0.rows.isEmpty }) {
            let n = items.reduce(0) { $0 + $1.rows.count }
            return "\(n) tasks waiting on you"
        }
        return waiting ? "\(items.count) updates" : "\(items.count) tasks done"
    }

    /// A bot's name and face over its waiting cards, where several bots share the pill.
    private func group(_ item: Item) -> some View {
        HStack(spacing: 6) {
            if let bot = store.bot(item.key) { BotFace(bot: bot, size: 16) }
            Button { open(item.key) } label: { DoneTitle(title: item.title, cap: 240) }
                .buttonStyle(.plain)
            Spacer(minLength: 0)
            OpenInAppButton { openInApp(item.key) }
        }
        .frame(height: Self.row)
        .padding(.top, item.key == items.first?.key ? 0 : 6)
    }

    private func line(_ item: Item) -> some View {
        HStack(spacing: 8) {
            Button { open(item.key) } label: { DoneTitle(title: item.title, cap: item.note == nil ? 240 : 120) }
                .buttonStyle(.plain)
            if item.note != nil {
                Text(Self.headline(item)).font(.system(size: 12)).foregroundStyle(StatusDot.waiting).lineLimit(1)
            }
            Spacer(minLength: 0)
            OpenInAppButton { openInApp(item.key) }
        }
        .frame(height: Self.row)
    }
}

/// One row of a bot's "Waiting on you" card, as the app hands it over with the notice (`useStalledTasks`).
struct WaitingTask: Decodable, Hashable {
    let id: String
    let title: String
    let projectPath: String
    let modified: String
    /// The line its bot wrote for the reader, where one was written since the task last moved.
    let need: String?
    /// Its PR can land, so the card carries Merge.
    let ready: Bool
    let pr: PrMark?
}

/// A waiting task as the bot chat's card draws it: face, title, PR and age, and
/// under them its bot's line for the reader. A click brings Dray forward on the
/// task; a ready PR lands from here, Merge then the method.
struct WaitingCard: View {
    @Environment(Store.self) private var store
    let task: WaitingTask
    let open: () -> Void
    /// Takes the method; answers why it failed, or nil once landed.
    let merge: (String) async -> String?
    @State private var hover = false
    @State var confirming = false
    @State private var merging = false
    @State private var failed: String?
    /// The app's `--accent-merge`.
    private static let green = Color(red: 0x23 / 255, green: 0x86 / 255, blue: 0x36 / 255)

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            // Seeded by the task, as the app's row draws it.
            BotFace(bot: Bot(id: task.id, name: "", path: "", avatar: nil), size: 26)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(task.title.isEmpty ? "Untitled" : task.title).lineLimit(1)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.92))
                    if let pr = task.pr {
                        HStack(spacing: 2) {
                            PrGlyph(mark: pr, size: 12)
                            Text("#\(pr.number)")
                        }
                        .font(.system(size: 12).monospacedDigit())
                        .foregroundStyle(.white.opacity(0.5))
                        .fixedSize()
                    }
                    Spacer(minLength: 4)
                    if task.ready, task.pr != nil { mergeControl }
                    if let at = parseDate(task.modified) {
                        Text(shortAge(at)).font(.system(size: 11).monospacedDigit()).foregroundStyle(.white.opacity(0.35))
                    }
                }
                .frame(minHeight: 22)
                if let need {
                    Text(need).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                } else if !task.ready {
                    // The bot is still reading the task; its line lands here.
                    Capsule().fill(.white.opacity(0.14)).frame(width: 160, height: 9).shimmer().padding(.vertical, 3)
                }
                // Drawn, not a tooltip: the pills' window is never key, so a tooltip never shows.
                if let failed {
                    Text(failed).font(.system(size: 12)).foregroundStyle(.red.opacity(0.9))
                        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.white.opacity(hover ? 0.13 : 0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture(perform: open)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.12), value: hover)
    }

    /// Read live where this island holds the task, since the bot may write it
    /// after the notice; drawn only while newer than the task's last move (`needLine`).
    private var need: String? {
        guard let item = store.items.first(where: { $0.key.id == task.id })?.value else { return task.need }
        guard let n = item.need, let at = parseDate(n.at), let moved = parseDate(item.modified) else { return nil }
        return at >= moved ? n.text : nil
    }

    /// Merge, then the method as the confirm: a repo may allow only some, and the
    /// pills' window never takes a menu. Squash, the default, is filled in the primary spot, last.
    @ViewBuilder private var mergeControl: some View {
        if confirming {
            Button("Cancel") { confirming = false }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white.opacity(0.55))
            ForEach(Self.methods, id: \.value) { m in
                fill(m.label, filled: m.value == "squash") {
                    confirming = false
                    merging = true
                    failed = nil
                    Task {
                        failed = await merge(m.value)
                        merging = false
                    }
                }
            }
        } else {
            fill(merging ? "Merging…" : "Merge") { confirming = true }
                .disabled(merging)
        }
    }

    private static let methods = [(value: "rebase", label: "Rebase"), (value: "merge", label: "Merge"), (value: "squash", label: "Squash")]

    private func fill(_ label: String, filled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .frame(height: 22)
                .background(filled ? Self.green : .white.opacity(0.14), in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize()
    }
}

private struct DoneTitle: View {
    let title: String
    let cap: CGFloat
    @State private var hover = false

    var body: some View {
        // Brightens under the pointer, since a click opens the island on it.
        Text(title.isEmpty ? "Untitled" : title).lineLimit(1)
            .font(.system(size: 13))
            .foregroundStyle(.white.opacity(hover ? 0.95 : 0.55))
            // A cap, not a fill: its own width up to the cap, then truncated.
            .frame(maxWidth: cap, alignment: .leading)
            .fixedSize(horizontal: true, vertical: false)
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.12), value: hover)
    }
}

private struct OpenInAppButton: View {
    /// ⌘⏎ opens the newest alone, so only its button names the chord.
    var chord = false
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text("Open in app")
                if chord { Text("⌘⏎").foregroundStyle(.white.opacity(0.45)) }
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .frame(height: 22)
            .background(.white.opacity(hover ? 0.22 : 0.12), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.12), value: hover)
    }
}

/// The shape every pill hangs in: from the notch, or a capsule above the Dock.
struct PillShell<Content: View>: View {
    let notch: Bool
    let notchHeight: CGFloat
    /// A soft edge in this colour while news is fresh; `Composer.glowing` says when.
    var glow: Color? = nil
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .padding(.top, notchHeight)
            // A floor to clear the notch, and no ceiling, so it hugs its words. Above the Dock there is nothing to clear.
            .frame(minWidth: notch ? 200 : 0)
            // Its own size, whatever the card it hangs from proposes; a narrower proposal centred the words in a clipped 200pt slot.
            .fixedSize()
            // Rows growing in stay inside the edge while it moves.
            .clipped()
            .background {
                Group {
                    if notch {
                        NotchShape(radius: 16).fill(.black)
                            .overlay { if let glow { NotchShape(radius: 16, closed: false).stroke(glow.opacity(0.25), lineWidth: 1) } }
                    } else {
                        RoundedRectangle(cornerRadius: 20, style: .continuous).fill(.black)
                            .overlay { if let glow { RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(glow.opacity(0.25), lineWidth: 1) } }
                    }
                }
                .shadow(color: glow?.opacity(0.45) ?? .clear, radius: 12)
                .padding(.horizontal, notch ? -NotchShape.ear : 0)
            }
            .contentShape(Rectangle())
    }
}
