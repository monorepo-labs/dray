import SwiftUI
import ThinkingOrbs

/// Opens a bot's task over its chat, so Back returns to the bot.
struct OpenTaskKey: EnvironmentKey { static let defaultValue: ((SessionKey) -> Void)? = nil }
/// Selects a session in the list: another bot's chat, from a chip in this one.
struct OpenSessionKey: EnvironmentKey { static let defaultValue: ((SessionKey) -> Void)? = nil }

extension EnvironmentValues {
    var openTask: ((SessionKey) -> Void)? {
        get { self[OpenTaskKey.self] }
        set { self[OpenTaskKey.self] = newValue }
    }
    var openSession: ((SessionKey) -> Void)? {
        get { self[OpenSessionKey.self] }
        set { self[OpenSessionKey.self] = newValue }
    }
}

// MARK: The list's row

/// A bot in the list, the desktop sidebar's inbox row: its face, its name over
/// how long since it last spoke, and one line of its newest reply — typing
/// dots while it works. The face carries the state: yellow while it waits on
/// the reader, the unread count once a reply lands.
struct BotListRow: View {
    @Environment(Store.self) private var store
    let server: UUID
    let bot: Bot
    /// None until its first message: Dray Bot opens on its welcome with no session behind it.
    let chat: SessionKey?

    var body: some View {
        let item = chat.flatMap { store.items[$0] }
        let asking = chat.map(store.isAsking) ?? false
        let unread = item?.status == "completed"
        let preview = chat.flatMap { store.previews[$0] }
        HStack(spacing: Theme.Space.m) {
            BotFace(bot: bot, size: 40)
                .overlay(alignment: .bottomTrailing) { badge(asking: asking, unread: unread, replies: preview?.replies ?? 0) }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Theme.Space.s) {
                    Text(bot.name)
                        .font(unread ? Theme.Font.body.font.weight(.semibold) : Theme.Font.body.font)
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if store.lost.contains(server) {
                        Image(systemName: "wifi.slash").font(Theme.Font.footnote.font).foregroundStyle(Theme.tertiary)
                    } else if let at = item.flatMap({ parseDate($0.modified) }) {
                        Text(shortAge(at)).font(Theme.Font.footnote.font.monospacedDigit()).foregroundStyle(Theme.tertiary)
                    }
                }
                Group {
                    if item?.busy == true && !asking {
                        TypingDots().frame(height: 20, alignment: .leading)
                    } else {
                        Text(previewLine(preview?.text ?? bot.greeting?.last ?? bot.welcome ?? ""))
                            .font(Theme.Font.subhead)
                            .foregroundStyle(Theme.secondary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 20, alignment: .leading)
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, Theme.Space.m)
        .padding(.vertical, Theme.Space.s)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    /// Ringed in the page's colour, the desktop's cut-out hole.
    @ViewBuilder private func badge(asking: Bool, unread: Bool, replies: Int) -> some View {
        if asking {
            Circle().fill(Theme.accent).frame(width: 12, height: 12)
                .overlay(Circle().stroke(Theme.page, lineWidth: 2.5))
                .offset(x: 2, y: 2)
                .accessibilityLabel("Waiting on you")
        } else if unread {
            Text(replies > 0 ? "\(replies)" : "")
                .font(.system(size: 11, weight: .semibold).monospacedDigit())
                .foregroundStyle(Theme.text)
                .frame(minWidth: 18, minHeight: 18)
                .background(Theme.unread, in: Capsule())
                .overlay(Capsule().stroke(Theme.page, lineWidth: 2.5))
                .offset(x: 3, y: 3)
                .accessibilityLabel(replies == 1 ? "1 new reply" : "\(replies) new replies")
        }
    }
}

/// A reply as one plain line: no fences, heading marks, emphasis or link syntax (`previewLine`).
func previewLine(_ text: String) -> String {
    var s = text.replacing(/```[\s\S]*?```/, with: " ")
    s = s.replacing(/(?m)^\s*(?:#{1,6}\s+|>\s?)+/, with: "")
    s = s.replacing(/[*`]+/, with: "")
    s = s.replacing(/\[([^\]]*)\]\([^)]*\)/) { String($0.output.1) }
    return s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
}

// MARK: The chat

/// A bot's chat: the conversation, a line where it started or messaged a task,
/// merge cards, lessons, and a time label wherever 15 minutes passed between rows.
/// Between two sessions of one bot chat: the agent the later one runs (`AGENT_LABELS`).
struct SwitchLine: View {
    let harness: String?

    var body: some View {
        let names = ["claude_code": "Claude Code", "codex": "Codex", "pi": "pi", "fx": "fx", "grok": "Grok"]
        Text("Switched to \(harness.map { names[$0] ?? $0 } ?? "another agent")")
            .font(Theme.Font.footnote)
            .foregroundStyle(Theme.tertiary)
            .frame(maxWidth: .infinity)
    }
}

struct BotChatRows: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let events: [AgentEvent]

    var body: some View {
        let items = botItems(events)
        let rows = botRows(items)
        ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
            if let label = timeLabel(rows, i) {
                Text(label).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                    .frame(maxWidth: .infinity).padding(.top, Theme.Space.s)
            }
            BotRowView(key: key, row: row, late: late(items, row))
        }
    }

    /// Before the first row, and before any row 15 minutes or more after the one above.
    private func timeLabel(_ rows: [BotRow], _ i: Int) -> String? {
        guard let at = rows[i].ts.flatMap(parseDate) else { return nil }
        if i > 0, let before = rows[i - 1].ts.flatMap(parseDate), at.timeIntervalSince(before) < 15 * 60 { return nil }
        return chatTime(at)
    }

    /// A card the reader has written three times past shrinks to its one line.
    private func late(_ items: [BotItem], _ row: BotRow) -> Bool {
        guard case .item(.card(let id, _, _)) = row, let i = items.firstIndex(where: { $0.id == id }) else { return false }
        return items[(i + 1)...].filter { if case .user = $0 { true } else { false } }.count >= 3
    }
}

/// "Today 18:44", "Yesterday 18:44", "Tuesday 18:44", "Tue, Nov 10 18:21": the desktop's `chatTime`.
func chatTime(_ date: Date, now: Date = .now) -> String {
    let cal = Calendar.current
    let clock = date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    if cal.isDateInToday(date) { return "Today \(clock)" }
    if cal.isDateInYesterday(date) { return "Yesterday \(clock)" }
    if now.timeIntervalSince(date) < 6 * 86400 { return "\(date.formatted(.dateTime.weekday(.wide))) \(clock)" }
    let sameYear = cal.component(.year, from: date) == cal.component(.year, from: now)
    let day = sameYear ? date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        : date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().year())
    return "\(day) \(clock)"
}

private struct BotRowView: View {
    @Environment(Store.self) private var store
    @Environment(\.openTask) private var openTask
    @Environment(\.openSession) private var openSession
    let key: SessionKey
    let row: BotRow
    let late: Bool
    @State private var expanded = false

    var body: some View {
        switch row {
        case .talk(_, let targets, _):
            talk(targets)
        case .item(let item):
            switch item {
            case .user(_, let text, let images, let reaction, _):
                UserBubble(text: text, from: nil, images: images, reaction: reaction)
            case .assistant(_, let text, _):
                MarkdownText(text: text)
                    .padding(.horizontal, Theme.Space.m)
                    .padding(.vertical, 10)
                    .background(Theme.card, in: .rect(cornerRadius: Theme.Radius.xl, style: .continuous))
                    .padding(.trailing, 32)
            case .notice(_, let text, _):
                FailureRow(text: text)
            case .card(_, let card, _):
                MergeCardView(server: key.server, card: card, compact: late)
            case .task(_, let id, _):
                line("Started a new task") { taskChip(id) }
            case .sent:
                EmptyView()
            case .botMessage(_, let botId, let title, let text, _):
                VStack(alignment: .trailing, spacing: Theme.Space.xs) {
                    line("Message from") { botChip(id: botId, name: title) }
                    UserBubble(text: text, from: nil)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            case .botSent(_, let name, let botId, _):
                line("Messaged") { botChip(id: botId, name: name) }
            case .learned(_, let lesson, _, let undone, _):
                HStack(spacing: 6) {
                    Text(lessonKind(lesson)).foregroundStyle(Theme.tertiary)
                    Text(lesson.summary).foregroundStyle(Theme.text.opacity(undone ? 0.5 : 0.8))
                        .strikethrough(undone).lineLimit(1)
                }
                .font(Theme.Font.subhead)
            }
        }
    }

    private func line(_ verb: String, @ViewBuilder chip: () -> some View) -> some View {
        HStack(spacing: 6) {
            Text(verb).font(Theme.Font.subhead).foregroundStyle(Theme.tertiary)
            chip()
        }
    }

    /// The task by its index entry, or by a prefix of its id as `dray session send` takes one.
    private func task(_ id: String) -> SessionKey? {
        let exact = SessionKey(server: key.server, id: id)
        if store.items[exact] != nil { return exact }
        let hits = store.items.keys.filter { $0.server == key.server && $0.id.hasPrefix(id.lowercased()) }
        return hits.count == 1 ? hits[0] : nil
    }

    private func taskChip(_ id: String) -> some View {
        let found = task(id)
        let title = found.flatMap { store.items[$0]?.title }.flatMap { $0.isEmpty ? nil : $0 } ?? "Task"
        return Button { if let found { openTask?(found) } } label: {
            Chip(face: BotFace(seed: found?.id ?? id, size: 18), title: title)
        }
        .buttonStyle(.plain)
        .disabled(found == nil)
    }

    private func botChip(id: String?, name: String) -> some View {
        let bots = store.bots[key.server] ?? []
        let named = bots.filter { $0.name.lowercased() == name.lowercased() }
        let bot = bots.first { $0.id == id } ?? bots.first { $0.id == name } ?? (named.count == 1 ? named[0] : nil)
        let chat = bot.flatMap { store.botChat(key.server, $0).last }
        return Button { if let chat { openSession?(chat) } } label: {
            Chip(face: bot.map { BotFace(bot: $0, size: 18) } ?? BotFace(seed: id ?? name, size: 18), title: bot?.name ?? name)
        }
        .buttonStyle(.plain)
        .disabled(chat == nil)
    }

    /// One task names it; several stack their faces over "N tasks" and open to a line each.
    @ViewBuilder private func talk(_ targets: [String]) -> some View {
        var seen = Set<String>()
        let parties = targets.filter { seen.insert(task($0)?.id ?? $0).inserted }
        if parties.count == 1 {
            line("Messaged") { taskChip(parties[0]) }
        } else {
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                line("Messaged") {
                    Button { withAnimation(Theme.motion) { expanded.toggle() } } label: {
                        HStack(spacing: 6) {
                            HStack(spacing: -8) {
                                ForEach(parties.prefix(3), id: \.self) { BotFace(seed: task($0)?.id ?? $0, size: 20) }
                            }
                            Text("\(parties.count) tasks").font(Theme.Font.subhead).foregroundStyle(Theme.text)
                            Chevron(open: expanded)
                        }
                    }
                    .buttonStyle(.plain)
                }
                if expanded {
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        ForEach(parties, id: \.self) { taskChip($0) }
                    }
                    .padding(.leading, Theme.Space.m)
                    .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 1) }
                }
            }
        }
    }
}

/// A face and a name, inline in a line of the chat.
private struct Chip: View {
    let face: BotFace
    let title: String

    var body: some View {
        HStack(spacing: 5) {
            face
            Text(title).font(Theme.Font.subhead).foregroundStyle(Theme.text).lineLimit(1)
        }
    }
}

/// "Rule", "New skill", "Removed memory": `lessonKind`.
func lessonKind(_ l: Lesson) -> String {
    let base = ["instructions": "Rule", "skill": "Skill", "memory": "Memory"][l.kind] ?? "Lesson"
    switch l.change {
    case "added": return "New \(base.lowercased())"
    case "removed": return "Removed \(base.lowercased())"
    default: return base
    }
}

// MARK: Merge card

/// The chat's merge card: the task and its PR's state, with Merge once GitHub
/// says it can land, or Fix conflicts. One line once merged or long past.
struct MergeCardView: View {
    @Environment(Store.self) private var store
    @Environment(\.openTask) private var openTask
    let server: UUID
    let card: MergeCard
    let compact: Bool
    @State private var asked = false

    var body: some View {
        let byBranch = store.marks[ProjectKey(server: server, path: card.prPath)]
        let pr = byBranch?.values.first { $0.number == card.number }
        let read = store.marksRead(server, card.prPath)
        let task = taskKey
        let title = task.flatMap { store.items[$0]?.title }.flatMap { $0.isEmpty ? nil : $0 } ?? card.title
        let verdict = pr.map(verdictOf)
        Group {
            if compact || pr?.state == "MERGED" || (read && pr == nil) {
                HStack(spacing: 6) {
                    if let pr { PrGlyph(mark: pr, size: 14) }
                    Link(pr?.state == "MERGED" ? "Merged #\(card.number)" : "#\(card.number)", destination: URL(string: card.url)!)
                        .foregroundStyle(Theme.secondary)
                    Text("·").foregroundStyle(Theme.tertiary)
                    Button { task.map { openTask?($0) } } label: { Chip(face: BotFace(seed: card.taskId, size: 16), title: title) }
                        .buttonStyle(.plain)
                        .disabled(task == nil)
                    Spacer(minLength: 0)
                    if let pr, let verdict { control(pr, verdict) }
                }
                .font(Theme.Font.subhead)
                .lineLimit(1)
            } else {
                HStack(spacing: Theme.Space.m) {
                    BotFace(seed: card.taskId, size: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Button { task.map { openTask?($0) } } label: {
                            Text(title).font(Theme.Font.body).foregroundStyle(Theme.text).lineLimit(1)
                        }
                        .buttonStyle(.plain)
                        .disabled(task == nil)
                        HStack(spacing: 5) {
                            if let pr { PrGlyph(mark: pr, size: 14) }
                            Link("#\(card.number)", destination: URL(string: card.url)!)
                                .foregroundStyle(Theme.secondary)
                                .font(Theme.Font.footnote.font.monospacedDigit())
                            if pr?.state == "OPEN" && pr?.checksState == "RUNNING" { ChecksSpinner().frame(width: 13, height: 13) }
                            if let words = words(pr, verdict) {
                                Text(words.text).foregroundStyle(words.tone)
                            }
                        }
                        .font(Theme.Font.footnote)
                        .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if let pr, let verdict { control(pr, verdict) }
                }
                .padding(14)
                .background(Theme.card, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.group, style: .continuous).strokeBorder(Theme.hairline))
            }
        }
        .task { await store.ensureMarks(server, card.prPath) }
    }

    /// The task where the phone can reach it: the chat's server, or for a task on
    /// another machine that machine as its server shares it. Nil where it is not shared.
    private var taskKey: SessionKey? {
        guard let machine = card.machine else { return SessionKey(server: server, id: card.taskId) }
        return store.servers.first { $0.via?.parent == server && ($0.via?.machine == machine || $0.name == machine) }
            .map { SessionKey(server: $0.id, id: card.taskId) }
    }

    @ViewBuilder private func control(_ pr: PrMark, _ verdict: MergeVerdict) -> some View {
        if pr.state == "OPEN" && !pr.isDraft && verdict == .ready {
            MergeTaskButton(server: server, taskId: card.taskId, cwd: card.prPath, number: card.number, branch: card.branch)
        } else if pr.state == "OPEN" && verdict == .conflict, let task = taskKey {
            Button(asked ? "Asked the task" : "Fix conflicts") {
                asked = true
                Task {
                    let sent = await store.send(task,
                                                "PR #\(card.number) has merge conflicts with its base branch. Fix them and push.")
                    if !sent { asked = false }
                }
            }
            .font(Theme.Font.pill)
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(Theme.raised, in: Capsule())
            .disabled(asked)
        }
    }

    private func words(_ pr: PrMark?, _ verdict: MergeVerdict?) -> (text: String, tone: Color)? {
        guard let pr, let verdict else { return ("Reading status…", Theme.tertiary) }
        _ = pr
        switch verdict {
        case .merged: return ("Merged", Theme.tertiary)
        case .closed: return ("Closed without merging", Theme.tertiary)
        case .unknown: return ("Checking mergeability…", Theme.accent)
        case .behind: return ("Behind base", Theme.accent)
        case .blocked: return ("Blocked", Theme.accent)
        case .conflict, .draft, .unstable, .ready: return nil
        }
    }
}

/// A mark's merge verdict, unread fields reading as GitHub still deciding.
func verdictOf(_ pr: PrMark) -> MergeVerdict {
    mergeVerdict(state: pr.state, isDraft: pr.isDraft, mergeable: pr.mergeable ?? "UNKNOWN",
                 mergeStateStatus: pr.mergeStateStatus ?? "UNKNOWN")
}

/// Merge for a bot's task: the method kept with the PR sheet's, a confirm, then the task settled.
struct MergeTaskButton: View {
    @Environment(Store.self) private var store
    let server: UUID
    let taskId: String
    let cwd: String
    let number: Int
    let branch: String
    @AppStorage("pr.mergeMethod") private var method = MergeMethod.squash
    @State private var confirming = false
    @State private var merging = false

    var body: some View {
        Button {
            confirming = true
        } label: {
            Text(merging ? "Merging…" : "Merge")
                .font(Theme.Font.pill)
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .frame(height: 34)
                .background(Theme.merge, in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(merging)
        .confirmationDialog("\(method.label) #\(number)?", isPresented: $confirming, titleVisibility: .visible) {
            ForEach(MergeMethod.allCases, id: \.self) { m in
                Button(m.label) {
                    method = m
                    merging = true
                    Task {
                        let ok = await store.mergeTask(server, taskId: taskId, cwd: cwd, number: number, branch: branch, method: m.rawValue)
                        ok ? Haptic.success() : Haptic.error()
                        merging = false
                    }
                }
            }
        } message: {
            Text("The task settles once it lands.")
        }
    }
}

// MARK: Waiting on you

/// A bot's task that waits on the reader: a PR ready to merge, or a task gone
/// quiet. Everything else a stalled task needs goes to its bot (`stalledTasks`).
struct Stall: Identifiable {
    let task: SessionKey
    let item: SessionItem
    let pr: PrMark?
    let ready: Bool
    var id: String { "\(task.id):\(ready ? "ready:\(pr?.number ?? 0)" : "waiting"):\(item.modified)" }
}

/// How long a task sits before it counts as waiting (`STALL_MS`).
private let stallAfter: TimeInterval = 5 * 60

extension Store {
    // ponytail: a ready PR's five minutes count from the task's last move, not from
    // when it turned ready as the desktop tracks; a PR that goes green late shows sooner.
    func stalls(_ tasks: [SessionKey], now: Date = .now) -> [Stall] {
        tasks.compactMap { key -> Stall? in
            guard let item = items[key], !item.busy, !isAsking(key), (self.tasks[key] ?? 0) == 0, item.aside != true,
                  let touched = parseDate(item.modified), now.timeIntervalSince(touched) >= stallAfter else { return nil }
            let pr = prMark(key, item)
            let status = pr.map(prStatus)
            if let status, ["unknown", "checksRunning", "merged"].contains(status) { return nil }
            if status == "ready" { return Stall(task: key, item: item, pr: pr, ready: true) }
            // The task's to mend, through its bot: never the reader's card.
            if let status, ["conflict", "checksFailing", "behind", "changesRequested"].contains(status) { return nil }
            return Stall(task: key, item: item, pr: pr, ready: false)
        }
        .sorted { $0.item.modified < $1.item.modified }
    }
}

/// `prStatus`'s key: checks speak before the merge state, since `BLOCKED` is usually them.
func prStatus(_ pr: PrMark) -> String {
    let v = verdictOf(pr)
    if v == .merged { return "merged" }
    if v == .closed { return "closed" }
    if v == .conflict { return "conflict" }
    if pr.checksState == "FAILING" { return "checksFailing" }
    if pr.checksState == "RUNNING" { return "checksRunning" }
    if v == .draft { return "draft" }
    if pr.reviewDecision == "CHANGES_REQUESTED" { return "changesRequested" }
    if pr.reviewDecision == "REVIEW_REQUIRED" { return "needsReview" }
    switch v {
    case .unstable: return "checksFailing"
    case .unknown: return "unknown"
    case .behind: return "behind"
    case .blocked: return "blocked"
    default: return "ready"
    }
}

/// The card at the foot of a bot's chat: its tasks that wait on the reader. X
/// puts it away until one of them moves and stalls again.
struct StalledCard: View {
    @Environment(Store.self) private var store
    @Environment(\.openTask) private var openTask
    let tasks: [SessionKey]
    @AppStorage("bot.dismissedStalls") private var dismissedRaw = ""

    var body: some View {
        // Stalls ripen with time alone, so the card looks again each minute.
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let dismissed = Set(dismissedRaw.split(separator: "\n").map(String.init))
            let rows = store.stalls(tasks, now: context.date).filter { !dismissed.contains($0.id) }
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text("Waiting on you").font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
                        Spacer()
                        Button {
                            // Capped, so years of dismissals never grow the defaults without end.
                            dismissedRaw = (Array(dismissed) + rows.map(\.id)).suffix(200).joined(separator: "\n")
                        } label: {
                            Image(systemName: "xmark").font(Theme.Font.footnoteStrong.font).foregroundStyle(Theme.tertiary)
                                .frame(width: 28, height: 28)
                        }
                        .accessibilityLabel("Dismiss")
                    }
                    .padding(.leading, Theme.Space.s)
                    ForEach(rows) { row($0) }
                }
                .padding(Theme.Space.xs)
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous).strokeBorder(Theme.border))
            }
        }
    }

    private func row(_ s: Stall) -> some View {
        let need = s.item.need.flatMap { n in parseDate(n.at).flatMap { at in
            parseDate(s.item.modified).map { at >= $0 ? n.text : nil } } ?? nil }
        return Button { openTask?(s.task) } label: {
            HStack(alignment: .top, spacing: 10) {
                BotFace(seed: s.task.id, size: 32)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(s.item.title.isEmpty ? "Untitled" : s.item.title)
                            .font(Theme.Font.subhead).foregroundStyle(Theme.text).lineLimit(1)
                        if let pr = s.pr {
                            PrGlyph(mark: pr, size: 13)
                            Text("#\(pr.number)").font(Theme.Font.footnote.font.monospacedDigit())
                                .foregroundStyle(s.ready ? Theme.add : Theme.secondary)
                        }
                        Spacer(minLength: 0)
                        if s.ready, let pr = s.pr {
                            MergeTaskButton(server: s.task.server, taskId: s.task.id, cwd: s.item.projectPath,
                                            number: pr.number, branch: pr.headRefName)
                        }
                        if let at = parseDate(s.item.modified) {
                            Text(shortAge(at)).font(Theme.Font.footnote.font.monospacedDigit()).foregroundStyle(Theme.tertiary)
                        }
                    }
                    if let need {
                        Text(need).font(Theme.Font.subhead).foregroundStyle(Theme.text.opacity(0.7))
                            .multilineTextAlignment(.leading)
                    } else if !s.ready {
                        // The bot is still reading the task; its line lands here.
                        Capsule().fill(Theme.tertiary.opacity(0.3)).frame(width: 160, height: 10).shimmer()
                            .padding(.vertical, 4)
                    }
                }
            }
            .padding(.horizontal, Theme.Space.s)
            .padding(.vertical, 6)
            .contentShape(.rect)
        }
        .buttonStyle(RowButtonStyle())
    }
}

// MARK: Tasks

/// A bot's tasks, which the list leaves out, in the desktop Tasks tab's order:
/// waiting on the reader, a PR ready to merge, one about to be, idle, then
/// working, set-aside ones last and faded. A tap opens one over the bot's chat.
struct BotTasksSheet: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// The bot's server: a task on any other is marked with the server glyph, as on desktop.
    let server: UUID
    let tasks: [SessionKey]
    let open: (SessionKey) -> Void

    var body: some View {
        NavigationStack {
            Group {
                if tasks.isEmpty {
                    Text("Nothing handed off yet. Work this bot starts shows up here.")
                        .font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
                        .multilineTextAlignment(.center).frame(maxWidth: 280)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(.bottom, 60)
                } else {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(ordered, id: \.self) { key in
                                if let item = store.items[key] { row(key, item) }
                            }
                        }
                        .padding(.horizontal, Theme.Space.s)
                        .padding(.top, Theme.Space.l)
                    }
                }
            }
            .navigationTitle("Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .background(Theme.card.ignoresSafeArea())
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.card)
        // Tasks are hidden, so the list never reads their repos' marks, and the order rests on them.
        .task {
            let repos = Set(tasks.compactMap { key in store.items[key].map { ProjectKey(server: key.server, path: $0.projectPath) } })
            for repo in repos { await store.ensureMarks(repo.server, repo.path) }
        }
    }

    private var ordered: [SessionKey] {
        // The PR wins over working, since merging is what the reader came for.
        func rank(_ key: SessionKey) -> Int {
            guard let item = store.items[key] else { return 7 }
            if item.aside == true { return 6 }
            if store.isAsking(key) { return 0 }
            if let pr = store.prMark(key, item), pr.state == "OPEN", !pr.isDraft {
                if verdictOf(pr) == .ready { return 1 }
                if ["checksRunning", "needsReview", "unknown"].contains(prStatus(pr)) { return 2 }
            }
            if item.busy || (store.tasks[key] ?? 0) > 0 { return 4 }
            return 3
        }
        return tasks.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
    }

    private func row(_ key: SessionKey, _ item: SessionItem) -> some View {
        let asking = store.isAsking(key)
        let pr = store.prMark(key, item)
        return Button {
            dismiss()
            open(key)
        } label: {
            HStack(spacing: 10) {
                Group {
                    if item.busy && !asking { Orb(.working) }
                    else if (store.tasks[key] ?? 0) > 0 && !asking { Orb(.background) }
                    else { BotFace(seed: key.id, size: 22) }
                }
                .frame(width: 22, height: 22)
                Text(item.title.isEmpty ? "Untitled" : item.title)
                    .font(Theme.Font.body)
                    .foregroundStyle(asking ? Theme.accent : Theme.text)
                    .lineLimit(1)
                Spacer(minLength: 0)
                // Asked of the bot's server, not `key`: a machine paired directly and shared too
                // can hand `botTasks` the shared copy of a task that runs right here.
                if store.items[SessionKey(server: server, id: key.id)] == nil {
                    ServerIcon().frame(width: 12, height: 12).foregroundStyle(Theme.secondary)
                        .accessibilityLabel("Runs on \(store.name(of: key.server))")
                }
                if let pr {
                    if pr.state == "OPEN" && pr.checksState == "RUNNING" { ChecksSpinner().frame(width: 14, height: 14) }
                    else { PrGlyph(mark: pr, size: 14) }
                    Text("#\(pr.number)").font(Theme.Font.footnote.font.monospacedDigit()).foregroundStyle(Theme.secondary)
                }
            }
            .padding(.horizontal, Theme.Space.m)
            .frame(height: 48)
            .contentShape(.rect)
        }
        .buttonStyle(RowButtonStyle())
        .accessibilityIdentifier("botTask")
        .opacity(item.aside == true ? 0.5 : 1)
    }
}
