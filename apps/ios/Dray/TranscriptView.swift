import SwiftUI
import ThinkingOrbs

struct TranscriptView: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    @State private var fixing = false
    @State private var showingTasks = false
    @Environment(\.openTask) private var openTask
    /// The floating banner's height, kept clear above the first row so it never sits on "Load earlier".
    @State private var bannerHeight: CGFloat = 0
    /// How many of a bot chat's earlier sessions are drawn above this one.
    @State private var earlier = 0
    /// Whether new rows scroll into view: dropped by the reader scrolling up (`FollowsBottom`).
    @State private var following = true

    private var item: SessionItem? { store.items[key] }
    private var busy: Bool { item?.busy ?? false }

    var body: some View {
        let transcript = store.transcripts[key]
        let bot = store.bot(key)
        // A bot's chat draws the conversation alone, so its turns are never built.
        let turns = bot == nil ? buildTurns(transcript?.events ?? [], busy: busy) : []
        let botChat = bot.map { store.botChat(key.server, $0) } ?? []
        let botTasks = bot == nil ? [] : store.botTasks(botChat)
        let asks = store.asks[key] ?? []
        let segments = segments(bot)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    if store.transcripts[segments[0]]?.olderBefore != nil || hidden(bot, segments) != nil { older(bot, segments) }
                    if transcript == nil {
                        placeholder
                    } else if bot == nil && turns.isEmpty && !busy && (store.queued[key] ?? []).isEmpty {
                        // A session made elsewhere can have no turns yet; blank would read as still loading.
                        EmptyState(title: "No messages yet", message: "Send one to start this session.") {
                            Image(systemName: "bubble.left").font(.largeTitle).foregroundStyle(Theme.tertiary)
                        }
                        .frame(minHeight: 420)
                    }
                    if bot != nil {
                        ForEach(Array(segments.enumerated()), id: \.element) { i, segment in
                            if i > 0 { SwitchLine(harness: store.items[segment]?.harness) }
                            if let events = store.transcripts[segment]?.events { BotChatRows(key: segment, events: events) }
                        }
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
                                .foregroundStyle(Theme.text)
                        }
                        .font(Theme.Font.footnote)
                    }
                    if busy, bot != nil {
                        // A review's turn draws nothing, its orb included.
                        if !inReviewTurn(transcript?.events ?? []) {
                            OrbLine(activity: .working, label: currentTool(transcript?.events ?? []) ?? "Working")
                        }
                    } else if busy {
                        WorkingLine()
                    } else if let n = store.tasks[key], n > 0 {
                        OrbLine(activity: .background, label: n == 1 ? "1 background task running" : "\(n) background tasks running")
                    }
                    ForEach(asks) { AskCard(key: key, event: $0) }
                    if bot != nil { StalledCard(tasks: botTasks) }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, Theme.Space.m)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .contentMargins(.top, bannerHeight, for: .scrollContent)
            // Opens on the newest turn. The stack is eager on purpose: a lazy one scrolled
            // to its end by estimate, and when the read replaced what the cache drew with
            // less, the view sat past the new end, blank until the reader swiped.
            .defaultScrollAnchor(.bottom)
            .modifier(FollowsBottom(following: $following))
            // The newest row, not the count, or loading earlier turns would jump to the end.
            .onChange(of: "\(turns.last?.id ?? "")|\(turns.last?.work.last?.newestId ?? "")|\(turns.last?.completed ?? false)|\(asks.count)|\(busy)|\(bot == nil ? "" : transcript?.events.last?.id ?? "")") {
                if following { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: store.sends[key]) {
                following = true
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
        .page()
        .environment(\.imageServer, store.connection(key.server))
        // A card arriving is the agent stopping to ask: felt, once per card.
        .onChange(of: asks.count) { old, new in if new > old { Haptic.warning() } }
        .safeAreaInset(edge: .bottom, spacing: 0) { ReplyDock(key: key) }
        .overlay(alignment: .top) {
            SessionBanner(server: key.server) { fixing = true }
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { bannerHeight = $0 }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { title }
            if bot != nil {
                // The PR button's place: a bot has no PR, and its tasks are what the list leaves out.
                ToolbarItem(placement: .primaryAction) {
                    Button { showingTasks = true } label: { Image(systemName: "checklist") }
                        .accessibilityLabel("Tasks")
                }
            }
        }
        .modifier(LocalServersButton(key: key, shown: bot == nil))
        .task { await store.open(key) }
        .prPanel(key)
        .sheet(isPresented: $showingTasks) { BotTasksSheet(tasks: botTasks, chat: botChat) { openTask?($0) } }
        .sheet(isPresented: $fixing) { SettingsView(focus: key.server) }
    }

    /// The session's title over where it runs: its project and its machine, never the branch.
    @ViewBuilder private var title: some View {
        if let bot = store.bot(key) {
            // A bot's folder is no project: its face and name, and where it runs.
            VStack(spacing: 1) {
                HStack(spacing: 6) {
                    BotFace(bot: bot, size: 20)
                    Text(bot.name).font(Theme.Font.headline).foregroundStyle(Theme.text).lineLimit(1)
                }
                HStack(spacing: 4) {
                    ServerIcon().frame(width: 11, height: 11)
                    Text(store.name(of: key.server))
                }
                .font(Theme.Font.footnote)
                .foregroundStyle(Theme.tertiary)
                .lineLimit(1)
            }
            .frame(maxWidth: 240)
            .accessibilityElement(children: .combine)
        } else {
            taskTitle
        }
    }

    private var taskTitle: some View {
        VStack(spacing: 1) {
            Text(item?.title.isEmpty == false ? item!.title : "Untitled")
                .font(Theme.Font.headline)
                .foregroundStyle(Theme.text)
                .lineLimit(1)
            if let item {
                HStack(spacing: 10) {
                    HStack(spacing: 4) {
                        // Boxed like the server glyph beside it: a symbol at a font size draws larger than 11pt.
                        Image(systemName: "folder.fill").resizable().scaledToFit().frame(width: 11, height: 11)
                        Text(item.project)
                    }
                    HStack(spacing: 4) {
                        ServerIcon().frame(width: 11, height: 11)
                        Text(store.name(of: key.server))
                    }
                }
                .font(Theme.Font.footnote)
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
            TranscriptSkeleton()
        }
    }

    /// A bot chat's sessions on screen, oldest first: this one, and the earlier ones an agent
    /// switch left, each drawn only once the one after it is read back to its start (`drawnSegments`).
    private func segments(_ bot: Bot?) -> [SessionKey] {
        guard let bot else { return [key] }
        let chat = store.botChat(key.server, bot)
        guard let i = chat.firstIndex(of: key) else { return [key] }
        return Array(chat[max(0, i - earlier)...i])
    }

    /// The session an agent switch left just above what is drawn, if any.
    private func hidden(_ bot: Bot?, _ segments: [SessionKey]) -> SessionKey? {
        guard let bot else { return nil }
        let chat = store.botChat(key.server, bot)
        return chat.firstIndex(of: segments[0]).flatMap { $0 > 0 ? chat[$0 - 1] : nil }
    }

    /// Earlier turns are paged in by asking, so the screen never jumps under a reader mid-sentence.
    /// Past the top session's start, the next ask draws the session before it.
    @ViewBuilder private func older(_ bot: Bot?, _ segments: [SessionKey]) -> some View {
        let top = segments[0]
        HStack {
            if let error = store.olderErrors[top] {
                Text("Couldn't load earlier messages. \(sentence(error))")
                    .font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
                Spacer(minLength: Theme.Space.s)
            }
            Button(store.olderErrors[top] == nil ? "Load earlier" : "Retry") {
                Task {
                    if store.transcripts[top]?.olderBefore != nil {
                        await store.loadOlder(top)
                    } else if let before = hidden(bot, segments) {
                        await store.load(before)
                        earlier += 1
                    }
                }
            }
                .font(Theme.Font.footnoteStrong)
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
    @State private var viewing: Gallery?

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
            if let prompt = turn.prompt { UserBubble(text: prompt.text, from: prompt.from, images: prompt.images) }
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
                        // The fold hides the calls, not what they showed; open, each row draws its own.
                        if !isOpen, case let shown = foldedImages(segment.items), !shown.isEmpty {
                            Thumbnails(images: shown)
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
        .environment(\.openImage) { ref in
            let shots = turn.gallery
            guard let i = shots.firstIndex(where: { $0.ref == ref }) else { return }
            instantly { viewing = Gallery(shots: shots, start: i) }
        }
        .imageViewer($viewing)
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
            // A running tool's label can be a whole script: one line, cut short.
            Text(label).font(Theme.Font.subhead).foregroundStyle(Theme.secondary).lineLimit(1).shimmer()
        }
        .accessibilityElement(children: .combine)
        .transition(.opacity)
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
            .font(Theme.Font.subhead)
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
            .font(Theme.Font.footnoteStrong.font)
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
        case .prompt(_, let text, let from, let images):
            UserBubble(text: text, from: from, images: images)
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
        .font(Theme.Font.subhead)
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
        .font(Theme.Font.subhead.font.monospacedDigit())
    }
}

/// The reader's own words, the one thing in the transcript set apart in a bubble.
struct UserBubble: View {
    let text: String
    let from: String?
    var images: [ImageRef] = []
    /// Typed into a running turn and not yet read by it: held back, dimmed.
    var queued = false
    /// A bot's emoji on this message, drawn on the bubble's corner.
    var reaction: String? = nil

    var body: some View {
        VStack(alignment: .trailing, spacing: Theme.Space.xs) {
            if let from {
                Label("From \(from)", systemImage: "arrow.turn.down.right")
                    .font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
            }
            if !images.isEmpty { Thumbnails(images: images) }
            if !text.isEmpty {
                Text(text)
                    .font(Theme.Font.body)
                    .foregroundStyle(Theme.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.xl, style: .continuous))
                    .overlay(alignment: .topLeading) {
                        if let reaction { ReactionBadge(emoji: reaction).offset(x: -12, y: -16) }
                    }
                    .padding(.top, reaction == nil ? 0 : 12)
            } else if let reaction {
                ReactionBadge(emoji: reaction)
            }
            if queued {
                Text("Queued").font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
            }
        }
        .opacity(queued ? 0.55 : 1)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
    }
}

/// A bot's reaction, as a messenger draws one: a round chip a step lighter than the
/// page, with a hairline edge. The desktop's `ReactionBadge`.
struct ReactionBadge: View {
    let emoji: String

    var body: some View {
        let labels = ["👀": "Seen", "✅": "Done", "🎉": "Celebrating", "👍": "Like", "❤️": "Love", "😂": "Laughing", "😢": "Sad"]
        Text(emoji)
            .font(.system(size: 15))
            .frame(width: 28, height: 28)
            .background(Theme.well, in: .circle)
            .overlay(Circle().strokeBorder(Theme.border, lineWidth: 0.5))
            .accessibilityLabel("Bot reacted: \(labels[emoji] ?? emoji)")
    }
}

/// Square thumbnails, each opening full screen on tap.
struct Thumbnails: View {
    let images: [ImageRef]

    var body: some View {
        ThumbnailRow(spacing: Theme.Space.xs) {
            ForEach(Array(images.enumerated()), id: \.offset) { _, ref in
                ImageButton(ref: ref) {
                    RemoteImage(ref: ref, fill: true)
                        .frame(width: 72, height: 72)
                        .clipShape(.rect(cornerRadius: Theme.Radius.md, style: .continuous))
                }
            }
        }
    }
}

/// A picture in the reading column, at most a screen's width and a little less tall.
struct InlineImage: View {
    let ref: ImageRef

    var body: some View {
        // Clipped before the frame, so the corners are the picture's and not the column's.
        RemoteImage(ref: ref)
            .clipShape(.rect(cornerRadius: Theme.Radius.md, style: .continuous))
            .frame(maxWidth: 320, maxHeight: 320, alignment: .leading)
    }
}

/// A picture that opens its turn's viewer on tap; outside a turn (a PR comment),
/// a viewer of its own.
struct ImageButton<Content: View>: View {
    @Environment(\.openImage) private var open
    let ref: ImageRef
    @ViewBuilder let content: Content
    @State private var alone: Gallery?

    var body: some View {
        Button {
            if let open {
                open(ref)
            } else {
                instantly { alone = Gallery(shots: [Shot(ref: ref, verb: "Image", target: nil)], start: 0) }
            }
        } label: { content }
            .buttonStyle(.plain)
            .accessibilityLabel("Open image")
            .imageViewer($alone)
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
                            .foregroundStyle(alarming ? Theme.destructive : Theme.secondary)
                            .shimmer(pending)
                            .layoutPriority(1)
                    }
                    if let summary {
                        Text(summary.split(separator: "\n").first.map(String.init) ?? summary)
                            .foregroundStyle(Theme.tertiary)
                            .lineLimit(1)
                    }
                    if let n = editCounts(call) { ChangeCount(added: n.added, removed: n.removed) }
                    if expandable { Chevron(open: open) }
                }
                .font(Theme.Font.subhead)
            }
            .buttonStyle(RowButtonStyle())
            // A picture the tool handed back is the result itself, so it shows unasked.
            ForEach(Array(call.images.enumerated()), id: \.offset) { _, ref in
                ImageButton(ref: ref) { InlineImage(ref: ref) }
            }
            if open, let output = call.output {
                ScrollView(.horizontal) {
                    Text(output.count > 6000 ? String(output.prefix(6000)) + "\n…" : output)
                        .font(Theme.Font.footnote)
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
                        .foregroundStyle(Theme.secondary)
                        .shimmer(pending)
                        .layoutPriority(1)
                    if let target { Text(target).foregroundStyle(Theme.tertiary).lineLimit(1) }
                    if calls.count > targets { Text("\(calls.count) calls").foregroundStyle(Theme.tertiary).layoutPriority(1) }
                    if added + removed > 0 { ChangeCount(added: added, removed: removed) }
                    Chevron(open: open)
                }
                .font(Theme.Font.subhead)
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
                        .font(level <= 2 ? Theme.Font.title.font : Theme.Font.headline.font)
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
                        Text(s).font(Theme.Font.footnote).foregroundStyle(Theme.text).padding(Theme.Space.m)
                    }
                    .well()
                case .rule:
                    Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 4)
                case .table(let rows):
                    MarkdownTable(rows: rows)
                        .font(Theme.Font.body)
                        .foregroundStyle(Theme.text)
                case .image(_, let url):
                    let ref = ImageRef(path: nil, url: url, mimeType: nil)
                    ImageButton(ref: ref) { InlineImage(ref: ref) }
                }
            }
            ForEach(recordingPaths(in: text), id: \.self) { RecordingPlayer(path: $0) }
            ForEach(screenshotPaths(in: text), id: \.self) { path in
                let ref = ImageRef(path: path, url: nil, mimeType: nil)
                ImageButton(ref: ref) { InlineImage(ref: ref) }
            }
        }
        .tint(Theme.link)
        .textSelection(.enabled)
    }
}

/// A transcript's shape while its first read is out with nothing cached: two
/// turns of grey bars, a prompt on the right and an answer under it.
struct TranscriptSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            turn(prompt: 180, lines: [1, 0.92, 0.6])
            turn(prompt: 120, lines: [0.85, 1, 0.95, 0.4])
        }
        .shimmer()
        .accessibilityElement()
        .accessibilityLabel("Loading")
    }

    private func turn(prompt: CGFloat, lines: [CGFloat]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .fill(Theme.raised)
                .frame(width: prompt, height: 40)
                .frame(maxWidth: .infinity, alignment: .trailing)
            bar(width: 0.4).opacity(0.6)
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, w in bar(width: w) }
            }
        }
    }

    private func bar(width: CGFloat) -> some View {
        GeometryReader { g in
            Capsule().fill(Theme.raised).frame(width: g.size.width * width, height: 12)
        }
        .frame(height: 12)
    }
}

/// The desktop chat's pin (`AT_BOTTOM_PX` in Chat.tsx): new rows follow while the
/// view is within 40pt of the end. Only a scroll the reader made drops it, since
/// rows landing push the end away too; coming back to the end raises it again.
/// iOS 17 has no scroll phase to tell the two apart, so there it always follows.
struct FollowsBottom: ViewModifier {
    @Binding var following: Bool
    @State private var reading = false

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content
                .onScrollPhaseChange { _, phase in reading = phase == .interacting || phase == .decelerating }
                .onScrollGeometryChange(for: CGFloat.self) { g in
                    g.contentSize.height + g.contentInsets.bottom - g.containerSize.height - g.contentOffset.y
                } action: { _, left in
                    if left < 40 { following = true } else if reading { following = false }
                }
        } else {
            content
        }
    }
}
