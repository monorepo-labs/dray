import SwiftUI

struct TranscriptView: View {
    @Environment(Store.self) private var store
    let key: SessionKey

    private var item: SessionItem? { store.items[key] }
    private var busy: Bool { item?.busy ?? false }

    var body: some View {
        let transcript = store.transcripts[key]
        let turns = buildTurns(transcript?.events ?? [], busy: busy)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if transcript?.olderBefore != nil {
                        Button("Load earlier") { Task { await store.loadOlder(key) } }
                            .frame(maxWidth: .infinity)
                    }
                    if transcript == nil {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    ForEach(turns) { TurnView(turn: $0) }
                    ForEach(store.queued[key] ?? [], id: \.id) { q in
                        UserBubble(text: q.text, from: nil).opacity(0.5)
                    }
                    if busy { WorkingLine() }
                    ForEach(store.asks[key] ?? []) { ask in
                        switch ask.payload {
                        case .permissionRequested(let r): PermissionCard(key: key, request: r)
                        case .questionsAsked(let r): QuestionsCard(key: key, request: r)
                        default: EmptyView()
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            // The newest row, not the count, or loading earlier turns would jump to the end.
            .onChange(of: "\(turns.last?.id ?? "")|\(turns.last?.work.last?.newestId ?? "")|\(turns.last?.completed ?? false)|\(store.asks[key]?.count ?? 0)|\(busy)") {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .safeAreaInset(edge: .bottom) { Composer(key: key, busy: busy) }
        .navigationTitle(item?.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .modifier(LocalServersButton(key: key))
        .task { await store.open(key) }
        .prPanel(key)
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
        VStack(alignment: .leading, spacing: 12) {
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
        if open.contains(i) { open.remove(i) } else { open.insert(i) }
    }
}

/// A wait drawn inline with the transcript: the orb and a shimmering word.
struct WorkingLine: View {
    /// One word per wait, never switching under the reader.
    @State private var label = ["Working", "Cooking", "Brewing", "Thinking"].randomElement()!

    var body: some View {
        HStack(spacing: 8) {
            Orb()
            Text(label).shimmer()
        }
        .accessibilityElement(children: .combine)
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
        VStack(alignment: .leading, spacing: 12) {
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
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
    }
}

/// Always drawn, dimmed while shut: a phone has no hover to reveal it on.
struct Chevron: View {
    let open: Bool

    var body: some View {
        Image(systemName: "chevron.right")
            .font(.caption2.weight(.semibold))
            .rotationEffect(.degrees(open ? 90 : 0))
            .foregroundStyle(open ? .secondary : .tertiary)
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
        Label(text, systemImage: "exclamationmark.circle")
            .foregroundStyle(.red)
            .font(.callout)
            .textSelection(.enabled)
    }
}

/// "+12 -3", the desktop's counter beside an edit.
struct ChangeCount: View {
    let added: Int
    let removed: Int

    var body: some View {
        HStack(spacing: 4) {
            if added > 0 { Text("+\(added)").foregroundStyle(.green) }
            if removed > 0 { Text("-\(removed)").foregroundStyle(.red) }
        }
        .font(.subheadline.monospacedDigit())
    }
}

struct UserBubble: View {
    let text: String
    let from: String?

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if let from {
                Text("From \(from)").font(.caption).foregroundStyle(.secondary)
            }
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 16))
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 40)
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
        VStack(alignment: .leading, spacing: 6) {
            Button {
                if expandable { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    // A delegated run is a whole agent being waited on, so it carries the orb.
                    if pending && call.toolType == "subagent_spawn" { Orb() }
                    // Inside a group the label is the only thing that turns red, so a failure keeps it.
                    if showLabel || summary == nil || alarming {
                        Text(toolLabel(call.name, pending: pending))
                            .foregroundStyle(alarming ? AnyShapeStyle(.red) : AnyShapeStyle(.primary.opacity(0.8)))
                            .shimmer(pending)
                            .layoutPriority(1)
                    }
                    if let summary {
                        Text(summary.split(separator: "\n").first.map(String.init) ?? summary)
                            .font(.subheadline.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let n = editCounts(call) { ChangeCount(added: n.added, removed: n.removed) }
                    if expandable { Chevron(open: open) }
                }
                .font(.subheadline)
            }
            .buttonStyle(.plain)
            if open, let output = call.output {
                ScrollView(.horizontal) {
                    Text(output.count > 6000 ? String(output.prefix(6000)) + "\n…" : output)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .padding(8)
                }
                .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 8))
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
        VStack(alignment: .leading, spacing: 6) {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: 6) {
                    // A failure inside does not colour the run; that row says so once opened.
                    Text(target == nil ? groupLabel(name, count: targets, pending: pending) : groupVerb(name, pending: pending))
                        .shimmer(pending)
                        .layoutPriority(1)
                    if let target { Text(target).font(.subheadline.monospaced()).lineLimit(1) }
                    if calls.count > targets { Text("\(calls.count) calls").layoutPriority(1) }
                    if added + removed > 0 { ChangeCount(added: added, removed: removed) }
                    Chevron(open: open)
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(calls) { ToolRow(call: $0, showLabel: false) }
                }
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(.separator).frame(width: 1) }
            }
        }
    }
}

/// Prose through the system's markdown, inline only since `Text` draws no
/// blocks; fenced code split out and drawn monospaced.
struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                if block.code {
                    ScrollView(.horizontal) {
                        Text(block.text).font(.caption.monospaced()).padding(8)
                    }
                    .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 8))
                } else {
                    Text(attributed(block.text))
                }
            }
        }
        .textSelection(.enabled)
    }

    private var blocks: [(code: Bool, text: String)] {
        var out: [(code: Bool, text: String)] = []
        var current: [Substring] = []
        var code = false
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                let joined = current.joined(separator: "\n").trimmingCharacters(in: .newlines)
                if !joined.isEmpty { out.append((code, joined)) }
                current = []
                code.toggle()
            } else {
                current.append(line)
            }
        }
        let joined = current.joined(separator: "\n").trimmingCharacters(in: .newlines)
        if !joined.isEmpty { out.append((code, joined)) }
        return out
    }

    private func attributed(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}

struct Composer: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let busy: Bool
    @State private var sending = false

    var body: some View {
        let draft = Binding(get: { store.drafts[key] ?? "" }, set: { store.drafts[key] = $0 })
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: draft, axis: .vertical)
                .lineLimit(1...6)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 18))
            if busy {
                Button {
                    Task { await store.interrupt(key) }
                } label: {
                    Image(systemName: "stop.circle.fill").font(.title)
                }
                .accessibilityLabel("Stop")
            }
            Button {
                let text = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return }
                sending = true
                Task {
                    // Only if untouched meanwhile: text typed while the send was out was never sent.
                    if await store.send(key, text), store.drafts[key]?.trimmingCharacters(in: .whitespacesAndNewlines) == text {
                        store.drafts[key] = nil
                    }
                    sending = false
                }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title)
            }
            .disabled(sending || draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

struct PermissionCard: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let request: PermissionRequest
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(request.title ?? request.displayName ?? request.toolName).font(.headline)
            if let d = request.description { Text(d).font(.callout).foregroundStyle(.secondary) }
            if let input = request.input {
                if let line = toolArgument(input) {
                    Text(line).font(.caption.monospaced()).lineLimit(4)
                }
            }
            ForEach(request.options, id: \.id) { option in
                Button {
                    busy = true
                    Task {
                        await store.respond(key, requestId: request.requestId, optionId: option.id)
                        busy = false
                    }
                } label: {
                    Text(option.label).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(option.behavior == "deny" ? .red : .accentColor)
            }
        }
        .disabled(busy)
        .padding()
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.yellow.opacity(0.6)))
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
        VStack(alignment: .leading, spacing: 14) {
            ForEach(request.questions, id: \.question) { q in
                VStack(alignment: .leading, spacing: 6) {
                    if let header = q.header { Text(header).font(.caption).foregroundStyle(.secondary) }
                    Text(q.question).font(.headline)
                    ForEach(q.options, id: \.label) { option in
                        let on = picks[q.question, default: []].contains(option.label)
                        Button {
                            toggle(q, option.label)
                        } label: {
                            HStack(alignment: .firstTextBaseline) {
                                Image(systemName: on ? (q.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                                                     : (q.multiSelect ? "square" : "circle"))
                                VStack(alignment: .leading) {
                                    Text(option.label)
                                    if let d = option.description {
                                        Text(d).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    if q.freeText != false {
                        TextField("Or type an answer", text: Binding(
                            get: { typed[q.question] ?? "" },
                            set: { typed[q.question] = $0 }
                        ))
                        .textFieldStyle(.roundedBorder)
                    }
                }
            }
            Button {
                busy = true
                Task {
                    await store.answer(key, requestId: request.requestId, answers: answers)
                    busy = false
                }
            } label: {
                Text("Submit").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .disabled(busy)
        .padding()
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.yellow.opacity(0.6)))
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
