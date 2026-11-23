import SwiftUI
import ThinkingOrbs

struct TranscriptView: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    @State private var fixing = false
    /// The screen's width, which the title's cap is taken from.
    @State private var width: CGFloat = 0
    @State private var showingTasks = false
    @State private var showingRuns = false
    /// The run a subagent row opened the sheet on.
    @State private var runFocus: String?
    @State private var subagent: SubagentRoute?
    @State private var editingBot = false
    @Environment(\.openTask) private var openTask
    @Environment(\.readOnly) private var readOnly
    /// The floating banner's height, kept clear above the first row so it never sits on "Load earlier".
    @State private var bannerHeight: CGFloat = 0
    /// Whether new rows scroll into view: dropped by the reader scrolling up (`FollowsBottom`).
    @State private var following = true
    /// The row "Load earlier" holds on screen, and its top in the content (`HoldsPlace`).
    @State private var held: String?
    @State private var heldTop: CGFloat?
    /// Pages being read for "Load earlier", counted since a tap can overlap a Retry.
    @State private var loads = 0
    /// A bot chat opened unread, its read done.
    @State private var openedUnread = false
    /// The last item it held once read, bounding the NEW divider.
    @State private var unreadUpTo: String?
    /// The reply unread ones begin at; settled once, so reading the chat never moves it.
    @State private var newFrom: String?? = nil

    private var item: SessionItem? { store.items[key] }
    private var busy: Bool { item?.busy ?? false }

    var body: some View {
        let transcript = store.transcripts[key]
        let bot = store.bot(key)
        // A bot's chat draws the conversation alone, so its turns are never built.
        let turns = bot == nil ? buildTurns(transcript?.events ?? [], busy: busy) : []
        let botTasks = bot.map { store.botTasks(store.botChat(key.server, $0)) } ?? []
        // Set-aside tasks are listed but not counted, as on the Tasks sheet and the desktop.
        let taskCount = botTasks.filter { store.items[$0]?.aside != true }.count
        let asks = store.asks[key] ?? []
        let taskAsks = store.hiddenAsks(bot == nil ? store.botTasks([key]) : botTasks)
        let segments = segments(bot)
        let chat = bot == nil ? [] : chatItems(segments)
        let complete = store.transcripts[segments[0]]?.olderBefore == nil && hidden(bot, segments) == nil
        let chatMark = "\(chat.count)|\(chat.first?.id ?? "")|\(complete)|\(store.serverRead.contains(key))"
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    // Never a run of sends: one folds into the run above it once that page lands, under a new id.
                    if !complete { older(bot, segments, first: bot == nil ? turns.first?.id : botRows(chat).first { if case .item = $0 { true } else { false } }?.id) }
                    if transcript == nil {
                        placeholder
                    } else if bot == nil && turns.isEmpty && !busy && (store.queued[key] ?? []).isEmpty {
                        // A session made elsewhere can have no turns yet; blank would read as still loading.
                        EmptyState(title: "No messages yet", message: "Send one to start this session.") {
                            Image(systemName: "bubble.left").font(.largeTitle).foregroundStyle(Theme.tertiary)
                        }
                        .frame(minHeight: 420)
                    }
                    if bot != nil { BotChatRows(key: key, items: chat, newFrom: newFrom ?? nil) }
                    ForEach(turns) { TurnView(turn: $0).heldRow($0.id) }
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
                    } else if let n = store.tasks[key]?.count, n > 0 {
                        // A bot's runs list under its tasks, as on desktop.
                        Button {
                            if bot != nil { showingTasks = true } else { runFocus = nil; showingRuns = true }
                        } label: {
                            OrbLine(activity: .background, label: n == 1 ? "1 background task running" : "\(n) background tasks running")
                                .contentShape(.rect)
                        }
                        .buttonStyle(RowButtonStyle())
                        .accessibilityIdentifier("backgroundTasks")
                    }
                    ForEach(asks) { AskCard(key: key, event: $0) }
                    // Answered by the task's own key, so the reply reaches its server, not this chat's.
                    ForEach(taskAsks, id: \.event.id) { t in
                        VStack(alignment: .leading, spacing: Theme.Space.xs) {
                            Text(store.items[t.key]?.title ?? "Task")
                                .font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
                                .lineLimit(1).padding(.leading, 2)
                            AskCard(key: t.key, event: t.event)
                        }
                    }
                    // One child with what a scroll to the end lands on, so the stack's spacing above it is the
                    // whole gap to the dock: the card draws nothing with no stalls, yet as a child of its own took spacing.
                    VStack(alignment: .leading, spacing: 0) {
                        if let bot { StalledCard(chat: key, botId: bot.id, tasks: botTasks) }
                        Color.clear.frame(height: 0).id("bottom")
                    }
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.top, Theme.Space.m)
                .coordinateSpace(.named(HoldsPlace.space))
                .environment(\.heldRow, held.map { id in HeldRow(id: id) { heldTop = $0 } })
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .contentMargins(.top, bannerHeight, for: .scrollContent)
            // Opens on the newest turn. The stack is eager on purpose: a lazy one scrolled
            // to its end by estimate, and when the read replaced what the cache drew with
            // less, the view sat past the new end, blank until the reader swiped.
            .defaultScrollAnchor(.bottom)
            .modifier(HoldsPlace(top: heldTop, following: following, loading: loads > 0) { held = nil; heldTop = nil })
            .modifier(FollowsBottom(following: $following) { proxy.scrollTo("bottom", anchor: .bottom) })
            // Before iOS 18 nothing reads the content's size, so the newest row is the cue.
            // The row, not the count, or loading earlier turns would jump to the end.
            .onChange(of: "\(turns.last?.id ?? "")|\(turns.last?.work.last?.newestId ?? "")|\(turns.last?.completed ?? false)|\(asks.count + taskAsks.count)|\(busy)|\(bot == nil ? "" : transcript?.events.last?.id ?? "")") {
                if following { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: store.sends[key]) {
                following = true
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
        .page()
        // The Tasks button is a reach to the top of the screen; a swipe in from the right edge is not.
        .background { if bot != nil { HostPan(start: .rightEdge) { _ in showingTasks = true } } }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width = $0 }
        .environment(\.imageServer, store.connection(key.server))
        .environment(\.callSession, key)
        // A card arriving is the agent stopping to ask: felt, once per card.
        .onChange(of: asks.count + taskAsks.count) { old, new in if new > old { Haptic.warning() } }
        .safeAreaInset(edge: .bottom, spacing: 0) { if !readOnly { ReplyDock(key: key) } }
        .overlay(alignment: .top) {
            // The bar draws no shade here, so rows fade out under the clock rather than sit on it.
            if bot != nil {
                // Spans the status bar and the bar under it: this view starts where they end,
                // so its distance from the screen's top is their height. Ignoring the safe area
                // instead reads an inset of zero.
                GeometryReader { g in
                    let top = g.frame(in: .global).minY
                    LinearGradient(stops: [.init(color: Theme.page, location: 0), .init(color: Theme.page.opacity(0.9), location: 0.4),
                                           .init(color: Theme.page.opacity(0), location: 1)],
                                   startPoint: .top, endPoint: .bottom)
                        .frame(height: top)
                        .offset(y: -top)
                }
                .allowsHitTesting(false)
            }
        }
        .overlay(alignment: .top) {
            SessionBanner(server: key.server) { fixing = true }
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { bannerHeight = $0 }
        }
        .navigationBarTitleDisplayMode(.inline)
        // Every control up there is a chip of its own, so the bar draws no shade behind them.
        .modifier(BareTopEdge(on: bot != nil))
        .toolbar {
            ToolbarItem(placement: .principal) { title }
            if bot != nil {
                // The PR button's place: a bot has no PR, and its tasks are what the list leaves out.
                ToolbarItem(placement: .primaryAction) {
                    Button { showingTasks = true } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "checklist")
                            if taskCount > 0 { Text("\(taskCount)").font(Theme.Font.headline.font.monospacedDigit()) }
                        }
                    }
                    // The label stays "Tasks", which UI tests find the button by.
                    .accessibilityLabel("Tasks")
                    .accessibilityValue(taskCount == 0 ? "" : "\(taskCount)")
                }
            }
        }
        .modifier(LocalServersButton(key: key, shown: bot == nil))
        .task { await open() }
        .onChange(of: chatMark) { settleUnread() }
        .changesButton(key, shown: bot == nil)
        .prPanel(key)
        .sheet(isPresented: $showingTasks) {
            BotTasksSheet(server: key.server, tasks: botTasks, runs: runKeys(bot), bot: bot) { openTask?($0) }
        }
        .sheet(isPresented: $showingRuns) { RunsSheet(key: key, focus: runFocus) }
        .navigationDestination(item: $subagent) { SubagentChat(route: $0) }
        .environment(\.openSubagent) { route in
            showingRuns = false
            showingTasks = false
            subagent = route
        }
        // A subagent row opens its chat where it has one, else the sheet on it, as on desktop.
        .environment(\.openRun) { id in
            let live = Set((store.tasks[key] ?? []).map(\.taskId))
            guard let run = buildRuns(transcript?.events ?? [], session: key, live: live, busy: busy).first(where: { $0.id == id })
            else { return false }
            if run.chat && !run.locked {
                subagent = SubagentRoute(session: key, id: id)
            } else {
                runFocus = id
                showingRuns = true
            }
            return true
        }
        .sheet(isPresented: $fixing) { SettingsView(focus: key.server) }
        .sheet(isPresented: $editingBot) { if let bot { BotSheet(editing: (key.server, bot)) } }
    }

    /// A task's title over where it runs, its project and its machine; a bot's chip.
    @ViewBuilder private var title: some View {
        if let bot = store.bot(key) {
            BotTitle(bot: bot) { editingBot = true }
        } else {
            taskTitle
        }
    }

    private var taskTitle: some View {
        VStack(alignment: .leading, spacing: 1) {
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
        // Wider than the room the bar leaves it, so it fills that room and starts at
        // the left, losing its end to the buttons. Under the bar's own width on purpose:
        // wider (or `.infinity`) kept the bar re-laying it out and the main thread never idled.
        .frame(maxWidth: max(160, width - 120), alignment: .leading)
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

    /// The bot chat's items across its sessions on screen. An agent switch draws nothing: the
    /// reader just picked the agent (#1414). The desktop's `chatItems`.
    private func chatItems(_ segments: [SessionKey]) -> [BotItem] {
        segments.flatMap { botItems(store.transcripts[$0]?.events ?? []) }
    }

    private func chat(_ bot: Bot?) -> [BotItem] { bot == nil ? [] : chatItems(segments(bot)) }

    /// Marks the session read, noting first whether a bot chat opened unread.
    private func open() async {
        let unread = store.bot(key) != nil && store.items[key]?.status == "completed"
        await store.open(key)
        openedUnread = unread
        settleUnread()
    }

    /// Sets where unread replies begin, once enough of the chat is loaded to say (`unreadStart`).
    private func settleUnread() {
        guard openedUnread, newFrom == nil else { return }
        let bot = store.bot(key)
        let items = chat(bot)
        if unreadUpTo == nil {
            // Taken once the server's read lands, never off the cache alone: replies it
            // brings count as unread, and later ones don't.
            guard store.serverRead.contains(key), let last = items.last?.id else { return }
            unreadUpTo = last
        }
        guard let upTo = unreadUpTo else { return }
        let segments = segments(bot)
        let complete = store.transcripts[segments[0]]?.olderBefore == nil && hidden(bot, segments) == nil
        if let at = unreadStart(items, upTo: upTo, complete: complete) { newFrom = at }
    }

    /// A bot chat's sessions on screen, oldest first: this one, and the earlier ones an agent
    /// switch left, each drawn once the one after it is read back to its start (`drawnSegments`)
    /// and it is held: "Load earlier" reads it, and a switch made here already holds it.
    private func segments(_ bot: Bot?) -> [SessionKey] {
        guard let bot else { return [key] }
        let chat = store.botChat(key.server, bot)
        guard let i = chat.firstIndex(of: key) else { return [key] }
        var start = i
        while start > 0, let top = store.transcripts[chat[start]], top.olderBefore == nil,
              store.transcripts[chat[start - 1]] != nil { start -= 1 }
        return Array(chat[start...i])
    }

    /// The sessions whose runs list: a bot's whole chat up to this one, newest first.
    private func runKeys(_ bot: Bot?) -> [SessionKey] {
        guard let bot else { return [key] }
        let chat = store.botChat(key.server, bot)
        guard let i = chat.firstIndex(of: key) else { return [key] }
        return chat[...i].reversed()
    }

    /// The session an agent switch left just above what is drawn, if any.
    private func hidden(_ bot: Bot?, _ segments: [SessionKey]) -> SessionKey? {
        guard let bot else { return nil }
        let chat = store.botChat(key.server, bot)
        return chat.firstIndex(of: segments[0]).flatMap { $0 > 0 ? chat[$0 - 1] : nil }
    }

    /// Reads what sits above the top: the page above, or past the top session's start, the
    /// session before it, held once read, which is what draws it (`segments`).
    private func loadEarlier(_ bot: Bot?, _ segments: [SessionKey], first: String?) async {
        if held != first { held = first; heldTop = nil }
        loads += 1
        defer { loads -= 1 }
        let top = segments[0]
        if store.transcripts[top]?.olderBefore != nil {
            await store.loadOlder(top)
        } else if let before = hidden(bot, segments) {
            await store.load(before)
        }
    }

    /// Earlier turns are paged in by asking, so the screen never jumps under a reader mid-sentence:
    /// the button, a spinner while the page reads, or why it failed and Retry.
    @ViewBuilder private func older(_ bot: Bot?, _ segments: [SessionKey], first: String?) -> some View {
        let top = segments[0]
        HStack {
            if let error = store.olderErrors[top] {
                Text("Couldn't load earlier messages. \(sentence(error))")
                    .font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
                Spacer(minLength: Theme.Space.s)
            }
            if store.olderLoading.contains(top), store.olderErrors[top] == nil {
                ProgressView().accessibilityIdentifier("loadingEarlier")
            } else {
                Button(store.olderErrors[top] == nil ? "Load earlier" : "Retry") {
                    Task { await loadEarlier(bot, segments, first: first) }
                }
                    .font(Theme.Font.footnoteStrong)
                    .foregroundStyle(Theme.secondary)
                    .padding(.horizontal, Theme.Space.m)
                    .padding(.vertical, Theme.Space.s)
                    .background(Theme.card, in: .rect(cornerRadius: Theme.Radius.sm, style: .continuous))
            }
        }
        // One height for the button and the spinner, so the swap moves nothing under it.
        .frame(maxWidth: .infinity, minHeight: 40)
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
    /// A bot's emoji on this message, beside the bubble's top corner.
    var reaction: String? = nil

    var body: some View {
        VStack(alignment: .trailing, spacing: Theme.Space.xs) {
            if let from {
                Label("From \(from)", systemImage: "arrow.turn.down.right")
                    .font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
            }
            // A message of pictures alone has no bubble, so the badge rides the first one.
            if !images.isEmpty { Thumbnails(images: images, reaction: text.isEmpty ? reaction : nil) }
            if !text.isEmpty {
                Text(text)
                    .font(Theme.Font.body)
                    .foregroundStyle(Theme.onSent)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.sent, in: .rect(cornerRadius: Theme.Radius.xl, style: .continuous))
                    .reaction(reaction)
            } else if images.isEmpty, let reaction {
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

/// Square thumbnails, each opening full screen on tap.
struct Thumbnails: View {
    let images: [ImageRef]
    /// A bot's emoji on the message, by the first picture's corner.
    var reaction: String? = nil

    var body: some View {
        ThumbnailRow(spacing: Theme.Space.xs) {
            ForEach(Array(images.enumerated()), id: \.offset) { i, ref in
                ImageButton(ref: ref) {
                    RemoteImage(ref: ref, fill: true)
                        .frame(width: 72, height: 72)
                        .clipShape(.rect(cornerRadius: Theme.Radius.md, style: .continuous))
                }
                .reaction(i == 0 ? reaction : nil)
            }
        }
        // The badge hangs past the row's edge, where a row too long to fit scrolls and would cut it.
        .scrollClipDisabled(reaction != nil)
    }
}

/// A picture in the reading column, at most a screen's width and a little less tall.
struct InlineImage: View {
    let ref: ImageRef
    var fallback: String?

    var body: some View {
        // Clipped before the frame, so the corners are the picture's and not the column's.
        RemoteImage(ref: ref, fallback: fallback)
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

extension EnvironmentValues {
    /// The session whose rows are drawn, for a row cut by a `lite` read to ask for its call.
    @Entry var callSession: SessionKey?
}

/// Where a cut call's read failed: said, with the read offered again, since the row has
/// nothing of its own to show.
struct CallFailed: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let callIds: [String]

    var body: some View {
        HStack(spacing: Theme.Space.s) {
            Text("Couldn't load this.").foregroundStyle(Theme.secondary)
            Button("Retry") { for id in callIds { store.completeCall(key, id) } }
                .foregroundStyle(Theme.text)
        }
        .font(Theme.Font.footnote)
    }
}

/// One call: its verb, what it acted on, and its output on tap.
struct ToolRow: View {
    let call: ToolCall
    /// False inside a group, whose header already says the verb.
    var showLabel = true
    @State private var open = false
    @Environment(\.openRun) private var openRun
    @Environment(\.callSession) private var session
    @Environment(Store.self) private var store

    var body: some View {
        let pending = call.state == .pending
        let failed = call.state == .failed
        let alarming = failed && !isRoutineError(call.output)
        let expandable = call.output?.isEmpty == false && (failed || !isWholeFileRead(call))
        let summary = call.name.hasPrefix("mcp__") ? mcpSummary(call.name) : call.summary
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Button {
                // A subagent's row opens what it is doing, as the desktop's opens its panel.
                if call.toolType == "subagent_spawn", let id = call.callId, openRun?(id) == true { return }
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
            if open, call.cut, let session, let id = call.callId, store.callFailed(session, id) {
                CallFailed(key: session, callIds: [id])
            }
            // A cut output opens onto nothing until its call lands, never onto a fragment.
            if open, !call.cut, let output = call.output {
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
        // Asked once needed: opened, or an edit, whose collapsed row counts its lines. On `open`
        // too, so a read that failed is asked again by opening the row again.
        .task(id: "\(open)|\(call.cut)") {
            guard call.cut, open || (call.toolType == "file_edit" && isCut(call.input)),
                  let session, let id = call.callId else { return }
            store.completeCall(session, id)
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
    @Environment(\.callSession) private var session
    @Environment(Store.self) private var store

    var body: some View {
        let pending = calls.contains { $0.state == .pending }
        // The header sums every edit, so it asks for each one cut and shows no sum of some of them.
        let cutEdits = calls.filter { $0.toolType == "file_edit" && isCut($0.input) }.compactMap(\.callId)
        let counts = cutEdits.isEmpty ? calls.compactMap(editCounts) : []
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
        .task(id: cutEdits) {
            guard let session else { return }
            for id in cutEdits { store.completeCall(session, id) }
        }
    }
}

/// Prose through the system's markdown, inline marks only, since `Text` draws
/// no blocks; headings, lists, quotes, rules and code fences are split out
/// here and drawn as the blocks they are.
struct MarkdownText: View {
    let text: String
    /// Off where a long press reacts instead, or the same press raises Copy under the emoji.
    var selectable = true

    var body: some View {
        let recordings = recordingPaths(in: text)
        let images = imagePaths(in: text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(markdownBlocks(hiding(recordings + images, in: text)).enumerated()), id: \.offset) { _, block in
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
                case .code(let s, let lang):
                    ScrollView(.horizontal) {
                        CodeBlock(code: s, lang: lang).font(Theme.Font.footnote).foregroundStyle(Theme.text).padding(Theme.Space.m)
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
            ForEach(recordings, id: \.self) { RecordingPlayer(path: $0) }
            ForEach(images, id: \.self) { path in
                let ref = ImageRef(path: path, url: nil, mimeType: nil)
                ImageButton(ref: ref) { InlineImage(ref: ref, fallback: path) }
            }
        }
        .tint(Theme.link)
        .selectable(selectable)
    }
}

private extension View {
    /// `textSelection` takes a type per answer, so the choice is two branches.
    @ViewBuilder func selectable(_ on: Bool) -> some View {
        if on { textSelection(.enabled) } else { textSelection(.disabled) }
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

/// The desktop chat's pin (`AT_BOTTOM_PX` and the ResizeObserver in Chat.tsx): within
/// 40pt of the end the view holds the end, whatever moves it. A row landing does, and
/// so does a picture or a video loading late, a fold opening and the dock growing, none
/// of which a new row announces. Only a scroll the reader made drops the pin, since each
/// of those pushes the end away too; coming back to the end raises it again.
/// iOS 17 reads no scroll geometry, so there the pin never drops and only new rows move the view.
struct FollowsBottom: ViewModifier {
    @Binding var following: Bool
    let toEnd: () -> Void
    @State private var reading = false
    /// What resizes put below a following view while a finger held it. The reader did not move
    /// that far, so it comes off the distance they are judged by, and is scrolled away on release.
    /// A reader already off the end is owed none: counted, it raised the pin that far short.
    @State private var grown: CGFloat = 0

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content
                .onScrollPhaseChange { _, phase in
                    reading = phase != .idle
                    guard phase == .idle else { return }
                    if following && grown != 0 { toEnd() }
                    grown = 0
                }
                // The content's height, the room it shows in, and what is left below the view.
                // Off `visibleRect`, which spans the insets: `containerSize` already has them out,
                // and taking the dock's off it again read 348pt left at the very end.
                .onScrollGeometryChange(for: [CGFloat].self) { g in
                    let end = g.visibleRect.maxY - g.contentInsets.bottom
                    return [g.contentSize.height, g.visibleRect.height - g.contentInsets.top - g.contentInsets.bottom, g.contentSize.height - end]
                } action: { old, new in
                    let resized = old[0] != new[0] || old[1] != new[1]
                    if reading && resized && following { grown += new[2] - old[2] }
                    if new[2] - grown < 40 { following = true } else if reading && !resized { following = false }
                    // Never from under a finger, and never for a move alone: a drag's first
                    // points arrive before its phase does, and a scroll then ends the drag.
                    if following && resized && !reading { toEnd() }
                }
                // About one warm open in fifty of a long chat sat at its top, with the geometry
                // still and so nothing above to move it. Why is not known; a scroll to the end
                // a few seconds on took, so one is sent once the push has settled, and again.
                .task {
                    for wait in [0.5, 1.0] {
                        try? await Task.sleep(for: .seconds(wait))
                        if following && !reading { toEnd() }
                    }
                }
        } else {
            content
        }
    }
}

/// Keeps the row first at a "Load earlier" tap still on screen as pages land above it, since a scroll
/// view holds its offset from the top (#1422); iOS 17 reads no scroll geometry, so there it still jumps.
struct HoldsPlace: ViewModifier {
    static let space = "transcript"
    /// The held row's top in the content; nil while nothing is held, or before it is first read.
    let top: CGFloat?
    let following: Bool
    let loading: Bool
    let release: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.modifier(Held(top: top, following: following, loading: loading, release: release))
        } else {
            content
        }
    }

    @available(iOS 18, *)
    private struct Held: ViewModifier {
        let top: CGFloat?
        let following: Bool
        let loading: Bool
        let release: () -> Void
        @State private var position = ScrollPosition()
        @State private var visible: CGRect = .zero
        /// From the content's top, as `scrollTo(y:)` takes it; `contentOffset` counts the inset above it too.
        @State private var offset: CGFloat = 0
        @State private var phase: ScrollPhase = .idle
        /// Held back while a finger or a fling has the view, since moving it then kills the fling.
        @State private var owed: CGFloat = 0

        func body(content: Content) -> some View {
            content
                .scrollPosition($position)
                .onScrollGeometryChange(for: CGRect.self) { $0.visibleRect } action: { visible = $1 }
                .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { offset = $1 }
                .onChange(of: top) { old, new in
                    guard let old, let new, !following else { return }
                    // Below the screen, what moves it is in view, so it is the reader's to see.
                    if visible.height > 0, old > visible.maxY { return end() }
                    owed += new - old
                    if phase == .idle { settle() }
                }
                .onScrollPhaseChange { old, new in
                    phase = new
                    if new == .idle { settle() }
                    // Any scroll of the reader's own ends it: a drag, or a status-bar tap or VoiceOver landing.
                    let theirs = new == .interacting || (old == .animating && new == .idle)
                    if theirs, !loading, owed == 0 { end() }
                }
                // So a send's scroll to the end can't land on an old target.
                .onChange(of: following) { if following { position = ScrollPosition() } }
        }

        private func settle() {
            guard owed != 0 else { return }
            // Read back only on the next scroll report, so two moves before it must add up.
            offset += owed
            visible.origin.y += owed
            position.scrollTo(y: offset)
            owed = 0
        }

        private func end() {
            release()
            owed = 0
            position = ScrollPosition()
        }
    }
}

/// The row a "Load earlier" holds still, and where its top is told (`HoldsPlace`).
struct HeldRow {
    let id: String
    let moved: (CGFloat) -> Void
}

extension EnvironmentValues {
    @Entry var heldRow: HeldRow?
}

extension View {
    /// Tells this row's top in the transcript while "Load earlier" holds it still (`HoldsPlace`).
    func heldRow(_ id: String) -> some View { modifier(HeldRowMark(id: id)) }
}

private struct HeldRowMark: ViewModifier {
    @Environment(\.heldRow) private var held
    let id: String

    func body(content: Content) -> some View {
        // In the background, so holding a row never changes its identity and resets its folds.
        content.background {
            if let held, held.id == id {
                Color.clear.onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(HoldsPlace.space)).minY } action: { held.moved($0) }
            }
        }
    }
}

/// Drops the bar's dark shade over scrolled rows where everything in it is glass.
struct BareTopEdge: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.scrollEdgeEffectHidden(on, for: .top)
        } else {
            content.toolbarBackground(on ? .hidden : .automatic, for: .navigationBar)
        }
    }
}

extension View {
    /// A glass capsule like the back button's, for a control the bar does not wrap itself.
    @ViewBuilder func glassChip() -> some View {
        if #available(iOS 26, *) {
            glassEffect(.regular.interactive(), in: .capsule)
        } else {
            background(.ultraThinMaterial, in: Capsule())
        }
    }
}
