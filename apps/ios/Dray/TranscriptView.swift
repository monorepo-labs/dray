import SwiftUI
import ThinkingOrbs

struct TranscriptView: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    @State private var fixing = false

    private var item: SessionItem? { store.items[key] }
    private var busy: Bool { item?.busy ?? false }

    var body: some View {
        let transcript = store.transcripts[key]
        let turns = buildTurns(transcript?.events ?? [], busy: busy)
        let asks = store.asks[key] ?? []
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 28) {
                    if transcript?.olderBefore != nil { older }
                    if transcript == nil {
                        placeholder
                    } else if turns.isEmpty && !busy && (store.queued[key] ?? []).isEmpty {
                        // A session made elsewhere can have no turns yet; blank would read as still loading.
                        EmptyState(title: "No messages yet", message: "Send one to start this session.") {
                            Image(systemName: "bubble.left").font(.largeTitle).foregroundStyle(Theme.tertiary)
                        }
                        .frame(minHeight: 420)
                    }
                    ForEach(turns) { TurnView(turn: $0) }
                    ForEach(store.queued[key] ?? [], id: \.id) { q in
                        UserBubble(text: q.text, from: nil, queued: true)
                    }
                    // Turns held but the refresh failed: what is on screen may be missing newer messages.
                    if transcript != nil, let error = store.transcriptErrors[key] {
                        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.destructive)
                            Text("Couldn't load new messages. \(sentence(error))").foregroundStyle(Theme.secondary)
                            Spacer(minLength: Theme.Space.s)
                            Button("Retry") { Task { await store.retryLoad(key) } }
                                .fontWeight(.semibold)
                                .foregroundStyle(Theme.text)
                        }
                        .font(Theme.Font.meta)
                    }
                    if busy {
                        WorkingLine()
                    } else if let n = store.tasks[key], n > 0 {
                        OrbLine(activity: .background, label: n == 1 ? "1 background task running" : "\(n) background tasks running")
                    }
                    ForEach(asks) { ask in
                        switch ask.payload {
                        case .permissionRequested(let r): PermissionCard(key: key, request: r)
                        case .questionsAsked(let r): QuestionsCard(key: key, request: r)
                        default: EmptyView()
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, Theme.Space.m)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            // Opens on the newest turn: a scrollTo on appear lands in a lazy stack's estimate and draws blank.
            .defaultScrollAnchor(.bottom)
            // The newest row, not the count, or loading earlier turns would jump to the end.
            .onChange(of: "\(turns.last?.id ?? "")|\(turns.last?.work.last?.newestId ?? "")|\(turns.last?.completed ?? false)|\(asks.count)|\(busy)") {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
        .page()
        // A card arriving is the agent stopping to ask: felt, once per card.
        .onChange(of: asks.count) { old, new in if new > old { Haptic.warning() } }
        .safeAreaInset(edge: .bottom) { Composer(key: key, busy: busy) { fixing = true } }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { title }
        }
        .modifier(LocalServersButton(key: key))
        .task { await store.open(key) }
        .prPanel(key)
        .sheet(isPresented: $fixing) { SettingsView(focus: key.server) }
    }

    /// The session's title over where it runs, in place of a bare title.
    private var title: some View {
        VStack(spacing: 1) {
            Text(item?.title.isEmpty == false ? item!.title : "Untitled")
                .font(.headline)
                .foregroundStyle(Theme.text)
                .lineLimit(1)
            if let item {
                Text([item.project, item.branch].compactMap { $0 }.joined(separator: " · "))
                    .font(Theme.Font.micro)
                    .foregroundStyle(Theme.tertiary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: 240)
        .accessibilityElement(children: .combine)
    }

    /// Nothing held yet: the read under way, or why it failed.
    @ViewBuilder private var placeholder: some View {
        if let error = store.transcriptErrors[key] {
            EmptyState(title: "Couldn't load this session", message: sentence(error)) {
                Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(Theme.tertiary)
            } actions: {
                Button { Task { await store.retryLoad(key) } } label: { Text("Try again").frame(maxWidth: .infinity) }
                    .buttonStyle(SecondaryButtonStyle())
            }
            .frame(minHeight: 420)
        } else {
            Orb(.loading, size: 32, label: "Loading")
                .frame(maxWidth: .infinity, minHeight: 320)
        }
    }

    /// Earlier turns are paged in by asking, so the screen never jumps under a reader mid-sentence.
    @ViewBuilder private var older: some View {
        HStack {
            if let error = store.olderErrors[key] {
                Text("Couldn't load earlier messages. \(sentence(error))")
                    .font(Theme.Font.meta).foregroundStyle(Theme.secondary)
                Spacer(minLength: Theme.Space.s)
            }
            Button(store.olderErrors[key] == nil ? "Load earlier" : "Retry") { Task { await store.loadOlder(key) } }
                .font(Theme.Font.meta.weight(.semibold))
                .foregroundStyle(Theme.secondary)
                .padding(.horizontal, Theme.Space.m)
                .padding(.vertical, Theme.Space.s)
                .background(Theme.card, in: .rect(cornerRadius: Theme.Radius.sm, style: .continuous))
        }
        .frame(maxWidth: .infinity)
    }
}

/// One turn: the prompt, its work folded behind a summary line once the
/// turn has finished, and the final answer. The desktop's `TurnBlock`.
struct TurnView: View {
    let turn: Turn
    /// Per stretch between queued prompts, by index: a running turn only appends.
    @State private var open: Set<Int> = []

    /// Below this many rows a fold costs a tap to reveal less than the line it stands in for.
    private static let collapseMin = 3

    var body: some View {
        let collapsible = !turn.running && turn.rows >= Self.collapseMin
        let segments = turn.segments
        // A lifted answer is out of every segment; a fallback one still sits in
        // whichever stretch holds it, which is not always the last.
        let answerOpen = turn.finalLifted ? false : segments.lastIndex {
            $0.items.contains { if case .text(_, let t) = $0 { t == turn.finalText } else { false } }
        }.map(open.contains) ?? false
        VStack(alignment: .leading, spacing: 14) {
            if let prompt = turn.prompt { UserBubble(text: prompt.text, from: prompt.from) }
            if collapsible || turn.running {
                ForEach(Array(segments.enumerated()), id: \.offset) { i, segment in
                    let isOpen = open.contains(i)
                    // Same index as the finished turn's last stretch, so a fold opened mid-turn stays open.
                    if turn.running && i == segments.count - 1 {
                        LiveWork(items: segment.items, open: isOpen) { toggle(i) }
                    } else {
                        if !segment.items.isEmpty {
                            SummaryToggle(label: summaryLabel(segment.items), open: isOpen) { toggle(i) }
                        }
                        if isOpen { ForEach(segment.items) { ItemView(item: $0) } }
                        if let prompt = segment.prompt { ItemView(item: prompt) }
                    }
                }
            } else {
                ForEach(turn.work) { ItemView(item: $0) }
            }
            // Collapsed, the last message stands in for the work; open, it already drew in place.
            if let text = turn.finalText, turn.finalLifted || (collapsible && !answerOpen) {
                MarkdownText(text: text)
            }
            if let failure = turn.failure { FailureRow(text: failure) }
        }
    }

    private func toggle(_ i: Int) {
        withAnimation(Theme.motion) {
            if open.contains(i) { open.remove(i) } else { open.insert(i) }
        }
    }
}

/// A wait drawn inline with the transcript: the orb and a shimmering word.
struct WorkingLine: View {
    /// One word per wait, never switching under the reader.
    @State private var label = ["Working", "Cooking", "Brewing", "Thinking"].randomElement()!

    var body: some View { OrbLine(activity: .working, label: label) }
}

/// The desktop's `OrbLine`: an orb for the wait and what it is, shimmering.
struct OrbLine: View {
    let activity: Activity
    let label: String

    var body: some View {
        HStack(spacing: Theme.Space.s) {
            Orb(activity)
            Text(label).font(Theme.Font.callout).foregroundStyle(Theme.secondary).shimmer()
        }
        .accessibilityElement(children: .combine)
        .transition(.opacity)
    }
}

extension View {
    /// The desktop's `shimmer-text`: a highlight sweeping across, the mark a
    /// live row wears. Holds still under Reduce Motion.
    func shimmer(_ on: Bool = true) -> some View { modifier(Shimmer(on: on)) }
}

private struct Shimmer: ViewModifier {
    let on: Bool
    @Environment(\.accessibilityReduceMotion) private var still

    func body(content: Content) -> some View {
        if on && !still {
            TimelineView(.animation) { timeline in
                let phase = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2) / 2
                content.mask {
                    LinearGradient(
                        stops: [.init(color: .black.opacity(0.5), location: 0.35),
                                .init(color: .black, location: 0.5),
                                .init(color: .black.opacity(0.5), location: 0.65)],
                        startPoint: UnitPoint(x: phase * 2 - 1, y: 0),
                        endPoint: UnitPoint(x: phase * 2, y: 0))
                }
            }
        } else {
            content
        }
    }
}

/// How many of a running turn's newest rows stay on screen. Older ones fold
/// behind the summary line, so a long turn stops growing down the screen and
/// lands already in its finished shape.
private let liveRows = 5

/// The stretch of a running turn being worked on. Past `liveRows` the oldest
/// row slides up under the summary line and fades as the next one lands.
struct LiveWork: View {
    let items: [Item]
    let open: Bool
    let onToggle: () -> Void

    var body: some View {
        let hidden = max(0, items.count - liveRows)
        let windowed = hidden > 0 && !open
        if hidden > 0 {
            SummaryToggle(label: summaryLabel(Array(items.prefix(hidden))), open: open, onToggle: onToggle)
        }
        VStack(alignment: .leading, spacing: 14) {
            ForEach(windowed ? Array(items.suffix(liveRows)) : items) { item in
                ItemView(item: item)
                    .transition(.asymmetric(insertion: .opacity, removal: .move(edge: .top).combined(with: .opacity)))
            }
        }
        // The fade is the design: the oldest row shown is the next to leave.
        .mask {
            VStack(spacing: 0) {
                LinearGradient(colors: [windowed ? .clear : .black, .black], startPoint: .top, endPoint: .bottom)
                    .frame(height: 40)
                Color.black
            }
        }
        .animation(.easeOut(duration: 0.3), value: items.count)
    }
}

struct SummaryToggle: View {
    let label: String
    let open: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 6) {
                Text(label).monospacedDigit()
                Chevron(open: open)
            }
            .font(Theme.Font.callout)
            .foregroundStyle(Theme.tertiary)
        }
        .buttonStyle(RowButtonStyle())
    }
}

/// Always drawn, dimmed while shut: a phone has no hover to reveal it on.
struct Chevron: View {
    let open: Bool

    var body: some View {
        Image(systemName: "chevron.right")
            .font(.caption2.weight(.bold))
            .rotationEffect(.degrees(open ? 90 : 0))
            .foregroundStyle(open ? Theme.secondary : Theme.tertiary)
    }
}

struct ItemView: View {
    let item: Item

    var body: some View {
        switch item {
        case .text(_, let text):
            MarkdownText(text: text)
        case .tool(let call):
            ToolRow(call: call)
        case .group(_, let name, let calls, let targets, let target):
            GroupRow(name: name, calls: calls, targets: targets, target: target)
        case .prompt(_, let text, let from):
            UserBubble(text: text, from: from)
        case .failure(_, let text):
            FailureRow(text: text)
        }
    }
}

struct FailureRow: View {
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
            Image(systemName: "exclamationmark.circle.fill")
            Text(text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .font(Theme.Font.callout)
        .foregroundStyle(Theme.destructive)
        .padding(Theme.Space.m)
        .background(Theme.destructive.opacity(0.1), in: .rect(cornerRadius: Theme.Radius.md, style: .continuous))
    }
}

/// "+12 -3", the desktop's counter beside an edit.
struct ChangeCount: View {
    let added: Int
    let removed: Int

    var body: some View {
        HStack(spacing: 4) {
            if added > 0 { Text("+\(added)").foregroundStyle(Theme.add) }
            if removed > 0 { Text("-\(removed)").foregroundStyle(Theme.destructive) }
        }
        .font(Theme.Font.callout.monospacedDigit())
    }
}

/// The reader's own words, the one thing in the transcript set apart in a bubble.
struct UserBubble: View {
    let text: String
    let from: String?
    /// Typed into a running turn and not yet read by it: held back, dimmed.
    var queued = false

    var body: some View {
        VStack(alignment: .trailing, spacing: Theme.Space.xs) {
            if let from {
                Label("From \(from)", systemImage: "arrow.turn.down.right")
                    .font(Theme.Font.micro).foregroundStyle(Theme.tertiary)
            }
            Text(text)
                .font(Theme.Font.body)
                .foregroundStyle(Theme.text)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.xl, style: .continuous))
            if queued {
                Text("Queued").font(Theme.Font.micro).foregroundStyle(Theme.tertiary)
            }
        }
        .opacity(queued ? 0.55 : 1)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
    }
}

/// One call: its verb, what it acted on, and its output on tap.
struct ToolRow: View {
    let call: ToolCall
    /// False inside a group, whose header already says the verb.
    var showLabel = true
    @State private var open = false

    var body: some View {
        let pending = call.state == .pending
        let failed = call.state == .failed
        let alarming = failed && !isRoutineError(call.output)
        let expandable = call.output?.isEmpty == false && (failed || !isWholeFileRead(call))
        let summary = call.name.hasPrefix("mcp__") ? mcpSummary(call.name) : call.summary
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Button {
                if expandable { withAnimation(Theme.motion) { open.toggle() } }
            } label: {
                HStack(spacing: 6) {
                    // A delegated run is a whole agent being waited on, so it carries the orb.
                    if pending && call.toolType == "subagent_spawn" { Orb(.delegating) }
                    // Inside a group the label is the only thing that turns red, so a failure keeps it.
                    if showLabel || summary == nil || alarming {
                        Text(toolLabel(call.name, pending: pending))
                            .fontWeight(.medium)
                            .foregroundStyle(alarming ? Theme.destructive : Theme.secondary)
                            .shimmer(pending)
                            .layoutPriority(1)
                    }
                    if let summary {
                        Text(summary.split(separator: "\n").first.map(String.init) ?? summary)
                            .font(Theme.Font.mono)
                            .foregroundStyle(Theme.tertiary)
                            .lineLimit(1)
                    }
                    if let n = editCounts(call) { ChangeCount(added: n.added, removed: n.removed) }
                    if expandable { Chevron(open: open) }
                }
                .font(Theme.Font.callout)
            }
            .buttonStyle(RowButtonStyle())
            if open, let output = call.output {
                ScrollView(.horizontal) {
                    Text(output.count > 6000 ? String(output.prefix(6000)) + "\n…" : output)
                        .font(Theme.Font.code)
                        .foregroundStyle(Theme.secondary)
                        .textSelection(.enabled)
                        .padding(Theme.Space.m)
                }
                .well()
                .transition(.opacity)
            }
        }
    }
}

/// A run of calls to one tool behind one row: "Read 3 files",
/// "Edited Store.swift +12 -3". Opens to the calls themselves.
struct GroupRow: View {
    let name: String
    let calls: [ToolCall]
    /// Distinct targets: three edits to one file is "1 file".
    let targets: Int
    /// The one target the whole run hit, named instead of counted.
    let target: String?
    @State private var open = false

    var body: some View {
        let pending = calls.contains { $0.state == .pending }
        let counts = calls.compactMap(editCounts)
        let added = counts.reduce(0) { $0 + $1.added }, removed = counts.reduce(0) { $0 + $1.removed }
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Button {
                withAnimation(Theme.motion) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    // A failure inside does not colour the run; that row says so once opened.
                    Text(target == nil ? groupLabel(name, count: targets, pending: pending) : groupVerb(name, pending: pending))
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.secondary)
                        .shimmer(pending)
                        .layoutPriority(1)
                    if let target { Text(target).font(Theme.Font.mono).foregroundStyle(Theme.tertiary).lineLimit(1) }
                    if calls.count > targets { Text("\(calls.count) calls").foregroundStyle(Theme.tertiary).layoutPriority(1) }
                    if added + removed > 0 { ChangeCount(added: added, removed: removed) }
                    Chevron(open: open)
                }
                .font(Theme.Font.callout)
            }
            .buttonStyle(RowButtonStyle())
            if open {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(calls) { ToolRow(call: $0, showLabel: false) }
                }
                .padding(.leading, Theme.Space.m)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 1) }
                .transition(.opacity)
            }
        }
    }
}

/// Prose through the system's markdown, inline marks only, since `Text` draws
/// no blocks; headings, lists, quotes, rules and code fences are split out
/// here and drawn as the blocks they are.
struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(markdownBlocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let s):
                    Text(inlineMarkdown(s)).font(Theme.Font.body).foregroundStyle(Theme.text)
                case .heading(let level, let s):
                    Text(inlineMarkdown(s))
                        .font(level <= 2 ? .title3.weight(.semibold) : .headline)
                        .foregroundStyle(Theme.text)
                        .padding(.top, 4)
                case .list(let items):
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                                Text(item.marker).monospacedDigit().foregroundStyle(Theme.tertiary)
                                Text(inlineMarkdown(item.text)).foregroundStyle(Theme.text)
                            }
                            .padding(.leading, CGFloat(item.indent) * 18)
                        }
                    }
                    .font(Theme.Font.body)
                case .quote(let s):
                    Text(inlineMarkdown(s))
                        .font(Theme.Font.body)
                        .foregroundStyle(Theme.secondary)
                        .padding(.leading, Theme.Space.m)
                        .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 3) }
                case .code(let s):
                    ScrollView(.horizontal) {
                        Text(s).font(Theme.Font.code).foregroundStyle(Theme.text).padding(Theme.Space.m)
                    }
                    .well()
                case .rule:
                    Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 4)
                case .table(let rows):
                    MarkdownTable(rows: rows)
                        .font(Theme.Font.body)
                        .foregroundStyle(Theme.text)
                }
            }
        }
        .tint(Theme.link)
        .textSelection(.enabled)
    }
}

/// The reply box, floating over the transcript's foot: the draft, and under it
/// the mic and Send — or Stop, while a turn runs and nothing is typed. A
/// dictation takes the row over with its orb.
struct Composer: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let busy: Bool
    let openSettings: () -> Void
    @State private var sending = false
    /// Why the last send failed; the draft is still there to send again.
    @State private var failed: String?

    var body: some View {
        let draft = Binding(get: { store.drafts[key] ?? "" }, set: { store.drafts[key] = $0 })
        let text = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let dictating = Dictations.shared.state(key) != .idle
        let connected = store.serverState[key.server] == .connected
        VStack(spacing: Theme.Space.s) {
            ConnectionStrip(server: key.server, openSettings: openSettings)
            VStack(alignment: .leading, spacing: 0) {
                if let failed {
                    HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.destructive)
                        Text("Couldn't send. \(sentence(failed))").foregroundStyle(Theme.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Button("Retry") { send(text) }
                            .fontWeight(.semibold)
                            .foregroundStyle(Theme.text)
                            .disabled(!connected || text.isEmpty)
                    }
                    .font(Theme.Font.meta)
                    .buttonStyle(.borderless)
                    .padding(.horizontal, Theme.Space.l)
                    .padding(.top, Theme.Space.m)
                }
                if Dictations.shared.notes[key] != nil {
                    DictationNote(draft: key)
                        .padding(.horizontal, Theme.Space.l)
                        .padding(.top, Theme.Space.m)
                }
                TextField("Message", text: draft, axis: .vertical)
                    .lineLimit(1...8)
                    .font(Theme.Font.body)
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, Theme.Space.l)
                    .padding(.top, 14)
                    .padding(.bottom, Theme.Space.xs)
                    .accessibilityLabel("Message")
                HStack(spacing: Theme.Space.xs) {
                    if dictating {
                        DictationBar(draft: key)
                    } else {
                        Spacer(minLength: 0)
                        DictateButton(server: key.server, draft: key)
                        if busy && text.isEmpty {
                            Button {
                                Haptic.firm()
                                Task { await store.interrupt(key) }
                            } label: { Image(systemName: "stop.fill") }
                                .buttonStyle(IconButtonStyle(filled: true))
                                .accessibilityLabel("Stop")
                        } else {
                            Button { send(text) } label: { Image(systemName: "arrow.up") }
                                .buttonStyle(IconButtonStyle(filled: true))
                                .disabled(sending || text.isEmpty || !connected)
                                .accessibilityLabel("Send")
                        }
                    }
                }
                .padding(.horizontal, Theme.Space.s)
                .padding(.bottom, Theme.Space.s)
                .frame(minHeight: 44)
            }
            .composerSurface()
            .padding(.horizontal, Theme.Space.m)
        }
        .padding(.bottom, Theme.Space.s)
        .frame(maxWidth: 760)
        .animation(Theme.motion, value: dictating)
        .animation(Theme.motion, value: failed)
        .animation(Theme.motion, value: connected)
        // Leaving the session mid-recording sends what was said, which lands in
        // the draft it was spoken into, the desktop's rule.
        .onDisappear {
            if Dictations.shared.state(key) == .recording { Task { await Dictations.shared.stop(store, draft: key) } }
        }
    }

    private func send(_ text: String) {
        guard !text.isEmpty else { return }
        sending = true
        failed = nil
        Haptic.tap()
        Task {
            if await store.send(key, text) {
                // Only if untouched meanwhile: text typed while the send was out was never sent.
                if store.drafts[key]?.trimmingCharacters(in: .whitespacesAndNewlines) == text { store.drafts[key] = nil }
            } else {
                // Said here, beside the draft it failed to send, rather than in the toast.
                failed = store.lastError ?? "The server didn't answer."
                store.lastError = nil
                Haptic.error()
            }
            sending = false
        }
    }
}

extension View {
    /// The composer's surface: glass where the system has it, a material
    /// washed in the card's colour before that, so the transcript reads as
    /// passing under it rather than through it.
    @ViewBuilder func composerSurface() -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
        if #available(iOS 26, *) {
            glassEffect(.regular.tint(Theme.card.opacity(0.55)), in: shape)
        } else {
            background(.ultraThinMaterial, in: shape)
                .background(Theme.card.opacity(0.6), in: shape)
                .overlay(shape.strokeBorder(Theme.border))
        }
    }
}

/// A question the agent cannot go on without, in the one colour that means
/// "this is for you".
private struct CardHeader: View {
    let symbol: String
    let text: String

    var body: some View {
        Label(text, systemImage: symbol)
            .font(Theme.Font.meta.weight(.semibold))
            .foregroundStyle(Theme.accent)
    }
}

struct PermissionCard: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let request: PermissionRequest
    @State private var busy = false

    var body: some View {
        // The first allow is the answer most often given, so it alone is filled.
        let primary = request.options.firstIndex { $0.behavior != "deny" }
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            CardHeader(symbol: "hand.raised.fill", text: "Needs your permission")
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                Text(request.title ?? request.displayName ?? request.toolName)
                    .font(Theme.Font.headline).foregroundStyle(Theme.text)
                if let d = request.description {
                    Text(d).font(Theme.Font.callout).foregroundStyle(Theme.secondary)
                }
            }
            if let input = request.input, let line = toolArgument(input) {
                Text(line)
                    .font(Theme.Font.code)
                    .foregroundStyle(Theme.text)
                    .lineLimit(6)
                    .padding(Theme.Space.m)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .well()
            }
            VStack(spacing: Theme.Space.s) {
                ForEach(Array(request.options.enumerated()), id: \.element.id) { i, option in
                    let answer = Button {
                        busy = true
                        Task {
                            await store.respond(key, requestId: request.requestId, optionId: option.id)
                            option.behavior == "deny" ? Haptic.tap() : Haptic.success()
                            busy = false
                        }
                    } label: {
                        Text(option.label).frame(maxWidth: .infinity)
                    }
                    if i == primary {
                        answer.buttonStyle(PrimaryButtonStyle())
                    } else {
                        answer.buttonStyle(SecondaryButtonStyle(ink: option.behavior == "deny" ? Theme.destructive : Theme.text))
                    }
                }
            }
        }
        .disabled(busy)
        .opacity(busy ? 0.6 : 1)
        .card(edge: Theme.accent.opacity(0.35))
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// Three answer shapes: an option's label, several labels comma-separated,
/// or free text. A question left blank is skipped, which is a real answer.
struct QuestionsCard: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let request: QuestionsRequest
    @State private var picks: [String: Set<String>] = [:]
    @State private var typed: [String: String] = [:]
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            CardHeader(symbol: "questionmark.bubble.fill",
                       text: request.questions.count == 1 ? "Needs your answer" : "\(request.questions.count) questions for you")
            ForEach(request.questions, id: \.question) { q in
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    Text(q.question).font(Theme.Font.headline).foregroundStyle(Theme.text)
                    ForEach(q.options, id: \.label) { option in
                        let on = picks[q.question, default: []].contains(option.label)
                        Button {
                            Haptic.select()
                            toggle(q, option.label)
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
                                Image(systemName: on ? (q.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                                                     : (q.multiSelect ? "square" : "circle"))
                                    .foregroundStyle(on ? Theme.accent : Theme.tertiary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.label).font(Theme.Font.body).foregroundStyle(Theme.text)
                                    if let d = option.description {
                                        Text(d).font(Theme.Font.meta).foregroundStyle(Theme.secondary)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(Theme.Space.m)
                            .background(on ? Theme.raised : Theme.well, in: .rect(cornerRadius: Theme.Radius.md, style: .continuous))
                        }
                        .buttonStyle(RowButtonStyle())
                    }
                    if q.freeText != false {
                        TextField("Or type an answer", text: Binding(
                            get: { typed[q.question] ?? "" },
                            set: { typed[q.question] = $0 }
                        ), axis: .vertical)
                        .font(Theme.Font.body)
                        .padding(Theme.Space.m)
                        .well()
                    }
                }
            }
            Button {
                busy = true
                Task {
                    await store.answer(key, requestId: request.requestId, answers: answers)
                    Haptic.success()
                    busy = false
                }
            } label: {
                Text("Submit").frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
        }
        .disabled(busy)
        .opacity(busy ? 0.6 : 1)
        .card(edge: Theme.accent.opacity(0.35))
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func toggle(_ q: Question, _ label: String) {
        var set = picks[q.question, default: []]
        if set.contains(label) { set.remove(label) }
        else if q.multiSelect { set.insert(label) }
        else { set = [label] }
        picks[q.question] = set
    }

    private var answers: [String: String] {
        var out: [String: String] = [:]
        for q in request.questions {
            let text = (typed[q.question] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty && q.freeText != false {
                out[q.question] = text
            } else if let set = picks[q.question], !set.isEmpty {
                // In option order, so the answer reads the way the menu did.
                out[q.question] = q.options.map(\.label).filter(set.contains).joined(separator: ", ")
            }
        }
        return out
    }
}
