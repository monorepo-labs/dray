import SwiftUI
import ThinkingOrbs

/// What the server says about a session's pull requests. Lives in the session
/// view, so the toolbar button knows whether there is anything to open.
@MainActor @Observable
final class PrModel {
    let key: SessionKey
    var prs: [PullRequest] = []
    var unavailable: PrUnavailable?
    var branch: String?
    /// False until the first read answers, which is what the skeleton stands for.
    var loaded = false
    var acting = false
    var actionError: String?
    @ObservationIgnored private var generation = 0

    init(key: SessionKey) { self.key = key }

    /// The button stays for the two states the reader can fix; every other
    /// error with no rows hides it, as the desktop's tab does.
    var visible: Bool { !prs.isEmpty || unavailable?.keepsButton == true }

    func load(_ store: Store) async {
        guard let item = store.items[key] else { return }
        generation += 1
        let gen = generation
        defer { if gen == generation { loaded = true } }
        do {
            let status: WorkStatus = try await store.call(key.server, "work_status", ["cwd": .string(item.cwd)])
            let branch = sessionBranch(branch: item.branch, worktreeName: item.worktreeName,
                                       worktreeRemoved: item.worktreeRemoved ?? false, observed: status.branch)
            guard let branch else {
                if gen == generation { (self.branch, prs, unavailable) = (nil, [], nil) }
                return
            }
            let prs: [PullRequest] = try await store.call(key.server, "prs_for_branch",
                                                          ["cwd": .string(item.cwd), "branch": .string(branch)])
            guard gen == generation else { return }
            (self.branch, self.prs, unavailable) = (branch, prs, nil)
        } catch {
            // Rows already on screen stay under the sentence, which says what failed to update.
            guard gen == generation else { return }
            unavailable = PrUnavailable.from(error)
        }
    }

    func act(_ store: Store, _ cmd: String, _ number: Int, _ extra: [String: JSON] = [:]) async {
        guard let cwd = store.items[key]?.cwd else { return }
        acting = true
        actionError = nil
        do {
            let _: JSON = try await store.call(key.server, cmd, ["cwd": .string(cwd), "number": JSON(number)].merging(extra) { $1 })
        } catch {
            actionError = error.localizedDescription
        }
        await load(store)
        acting = false
    }
}

private struct WorkStatus: Decodable {
    let branch: String?
}

extension PrUnavailable {
    /// `prs_for_branch` rejects with a typed object, which the connection
    /// hands over as its JSON text; anything else is the call itself failing.
    static func from(_ error: Error) -> PrUnavailable {
        let text = error.localizedDescription
        return (try? JSONDecoder().decode(PrUnavailable.self, from: Data(text.utf8)))
            ?? PrUnavailable(kind: "other", detail: text)
    }
}

extension View {
    /// The PR button in the session's toolbar and the sheet it opens. Re-read
    /// on arriving and whenever a turn ends, since a turn is what opens a PR.
    func prPanel(_ key: SessionKey) -> some View { modifier(PrPanelModifier(key: key)) }
}

private struct PrPanelModifier: ViewModifier {
    @Environment(Store.self) private var store
    @State private var model: PrModel
    @State private var showing = false

    init(key: SessionKey) { _model = State(initialValue: PrModel(key: key)) }

    func body(content: Content) -> some View {
        let busy = store.items[model.key]?.busy ?? false
        let connected = store.serverState[model.key.server] == .connected
        content
            // On arrival, on every turn edge, and on reconnect, where a read
            // that failed with the socket down would otherwise never retry.
            .task(id: "\(busy)|\(connected)") { if connected { await model.load(store) } }
            .toolbar {
                if model.visible {
                    ToolbarItem(placement: .primaryAction) {
                        // The list row's own glyph, so the button says the PR's state before it is opened.
                        Button { showing = true } label: {
                            if let pr = model.prs.first {
                                PrGlyph(mark: pr.mark, size: 18)
                            } else {
                                Image(systemName: "arrow.triangle.pull")
                            }
                        }
                        .accessibilityLabel("Pull request")
                    }
                }
            }
            .sheet(isPresented: $showing) { PrSheet(model: model) }
    }
}

extension PullRequest {
    /// This PR as the list's mark, so the toolbar and the sheet draw the row's own glyph.
    var mark: PrMark {
        let checks = checks.contains { $0.state == "failure" } ? "FAILING"
            : checks.contains { $0.state == "pending" } ? "RUNNING" : "CLEAR"
        return PrMark(number: number, headRefName: "", isDraft: isDraft, state: state, checksState: checks)
    }
}

struct PrSheet: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    let model: PrModel

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.card)
                .navigationTitle("Pull request")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { dismiss() }.fontWeight(.semibold) }
        }
        .presentationBackground(Theme.card)
        // The desktop's poll: quicker while GitHub is still working something out.
        .task {
            while !Task.isCancelled {
                await model.load(store)
                try? await Task.sleep(for: .seconds(model.prs.contains(where: \.settling) ? 15 : 60))
            }
        }
    }

    @ViewBuilder private var content: some View {
        if !model.loaded {
            ScrollView { PrSkeleton().padding(.horizontal, 20).padding(.top, 14) }
                .scrollDisabled(true)
                .accessibilityLabel("Loading pull request")
        } else if model.prs.isEmpty, let u = model.unavailable, u.keepsButton {
            MissingCli(kind: u.kind, model: model)
        } else if model.prs.isEmpty {
            // No PR yet, or a failure with nothing on screen to keep: one centred sentence either way.
            PrNotice(title: model.unavailable == nil ? "No pull request yet" : "Couldn't ask GitHub",
                     message: model.unavailable.map(\.sentence) ?? "It shows here once one is opened.") {
                PrOutline(tone: Theme.tertiary, dashed: true)
            } actions: {}
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    if let u = model.unavailable {
                        Text(.init(u.sentence)).font(Theme.Font.footnote).foregroundStyle(Theme.destructive)
                    }
                    if let e = model.actionError {
                        Text(sentence(e)).font(Theme.Font.footnote).foregroundStyle(Theme.destructive)
                    }
                    ForEach(model.prs) { PrSection(pr: $0, model: model) }
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, Theme.Space.xl)
            }
            .refreshable { await model.load(store) }
        }
    }
}

/// One pull request: what it is, whether it can land and the one action that
/// moves it, then its checks and what people said.
private struct PrSection: View {
    @Environment(Store.self) private var store
    let pr: PullRequest
    let model: PrModel

    var body: some View {
        let ready = readiness(pr)
        VStack(alignment: .leading, spacing: 28) {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Link(destination: URL(string: pr.url) ?? URL(string: "https://github.com")!) {
                        HStack(alignment: .top, spacing: 10) {
                            PrGlyph(mark: pr.mark, size: 20).padding(.top, 3)
                            Text(pr.title)
                                .font(Theme.Font.title)
                                .foregroundStyle(Theme.text)
                                .multilineTextAlignment(.leading)
                        }
                    }
                    HStack(spacing: 6) {
                        Text("#\(pr.number) · \(pr.author)").foregroundStyle(Theme.secondary)
                        Text("+\(pr.additions)").foregroundStyle(Theme.add)
                        Text("−\(pr.deletions)").foregroundStyle(Theme.destructive)
                        Text("· \(pr.changedFiles) \(pr.changedFiles == 1 ? "file" : "files")").foregroundStyle(Theme.secondary)
                    }
                    .font(Theme.Font.footnote)
                    .lineLimit(1)
                    .padding(.leading, 30)
                }

                VStack(alignment: .leading, spacing: Theme.Space.m) {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(ready.label).foregroundStyle(tone)
                            if pr.state == "OPEN" {
                                Text("into \(pr.baseRefName)").foregroundStyle(Theme.tertiary).lineLimit(1)
                            }
                        }
                        .font(Theme.Font.subhead)
                        if let detail = ready.detail {
                            Text(detail).font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
                        }
                    }
                    action
                }
                .prGroup()
            }

            if !pr.checks.isEmpty {
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    HStack {
                        Text("Checks")
                        Spacer()
                        Text(checksSummary)
                    }
                    .font(Theme.Font.footnote)
                    .foregroundStyle(Theme.tertiary)
                    .padding(.horizontal, Theme.Space.xs)
                    VStack(spacing: 0) {
                        ForEach(sortedChecks, id: \.self) { CheckRow(check: $0) }
                    }
                    .padding(.vertical, Theme.Space.xs)
                    .prGroup(padding: 0)
                }
            }
            if !pr.comments.isEmpty {
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    GroupLabel("Comments")
                    ForEach(pr.comments) { CommentCard(comment: $0) }
                }
            }
        }
    }

    /// Failing first, then running: what the reader opened the sheet to find.
    private var sortedChecks: [PrCheck] {
        let rank = ["failure": 0, "pending": 1]
        return pr.checks.enumerated()
            .sorted { (rank[$0.element.state] ?? 2, $0.offset) < (rank[$1.element.state] ?? 2, $1.offset) }
            .map(\.element)
    }

    private var checksSummary: String {
        let failing = pr.failingChecks
        if failing > 0 { return "\(failing) failing" }
        let done = pr.checks.filter { $0.state != "pending" }.count
        return done < pr.checks.count ? "\(done) of \(pr.checks.count) done" : "All passed"
    }

    private var tone: Color {
        if pr.checksHold { return Theme.accent }
        switch pr.verdict {
        case .ready: return Theme.add
        case .conflict: return Theme.destructive
        case .behind, .blocked, .unstable, .unknown: return Theme.accent
        case .merged: return Theme.merged
        case .closed, .draft: return Theme.secondary
        }
    }

    /// Reopen, mark ready, or merge — and no close or branch delete, as on the desktop.
    @ViewBuilder private var action: some View {
        if model.acting {
            HStack(spacing: Theme.Space.s) {
                Orb(.working)
                Text("Working…").font(Theme.Font.subhead).foregroundStyle(Theme.secondary).shimmer()
            }
            .frame(minHeight: 44)
        } else if pr.state == "CLOSED" {
            Button { Task { await model.act(store, "reopen_pr", pr.number) } } label: {
                Text("Reopen").frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryButtonStyle(fill: Theme.tile, capsule: true))
        } else if pr.state == "OPEN" && pr.isDraft {
            Button { Task { await model.act(store, "mark_pr_ready", pr.number) } } label: {
                Text("Ready for review").frame(maxWidth: .infinity)
            }
            .buttonStyle(CapsuleButtonStyle())
        } else if pr.state == "OPEN" {
            MergeButton(pr: pr, model: model)
        }
    }
}

/// How a merge lands on the base, the desktop's `METHOD_LABEL` and `METHOD_DETAIL` cut to a phone's width.
enum MergeMethod: String, CaseIterable {
    case squash, merge, rebase

    var label: String {
        switch self {
        case .squash: "Squash and merge"
        case .merge: "Create a merge commit"
        case .rebase: "Rebase and merge"
        }
    }

    var detail: String {
        switch self {
        case .squash: "All commits become one new commit."
        case .merge: "Every commit is kept, plus a merge commit."
        case .rebase: "Each commit replayed onto the base."
        }
    }

    func landing(on base: String) -> String {
        switch self {
        case .squash: "All commits become one commit on \(base)."
        case .merge: "Every commit lands on \(base), plus a merge commit."
        case .rebase: "Each commit is replayed onto \(base)."
        }
    }
}

/// One green pill with a seam, the desktop's split button: the left merges
/// after a confirm, the chevron picks how. The pick is kept on the phone.
private struct MergeButton: View {
    @Environment(Store.self) private var store
    let pr: PullRequest
    let model: PrModel
    @AppStorage("pr.mergeMethod") private var method = MergeMethod.squash
    @State private var confirming = false

    var body: some View {
        HStack(spacing: 0) {
            Button { confirming = true } label: {
                Text(method.label)
                    .font(Theme.Font.headline)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    // Centres the label on the whole pill, not on what the chevron leaves.
                    .padding(.leading, 52)
                    .contentShape(.rect)
            }
            .buttonStyle(RowButtonStyle())
            Rectangle().fill(.black.opacity(0.25)).frame(width: 1)
            Menu {
                // Toggles, not a Picker: a Picker row drops its subtitle, and a
                // Button inside one swallows the pick. A menu draws a toggle with
                // the leading check and its second text as the subtitle.
                ForEach(MergeMethod.allCases, id: \.self) { m in
                    Toggle(isOn: Binding(get: { method == m }, set: { if $0 { method = m } })) {
                        Text(m.label)
                        Text(m.detail)
                    }
                }
            } label: {
                Image(systemName: "chevron.down")
                    .font(Theme.Font.pill.font)
                    .frame(width: 52)
                    .frame(maxHeight: .infinity)
                    .contentShape(.rect)
            }
            .accessibilityLabel("Merge method")
        }
        .foregroundStyle(.white)
        .frame(height: 44)
        .background(Theme.merge, in: Capsule())
        // Dim while GitHub would refuse it; inert while checks run or fail, as the line above says.
        .opacity(pr.verdict == .ready && !pr.checksHold ? 1 : 0.6)
        .allowsHitTesting(!pr.checksHold)
        .accessibilityElement(children: .contain)
        .confirmationDialog("\(method.label) #\(pr.number)?", isPresented: $confirming, titleVisibility: .visible) {
            Button(method.label) {
                Task {
                    await model.act(store, "merge_pr", pr.number, ["method": .string(method.rawValue)])
                    model.actionError == nil ? Haptic.success() : Haptic.error()
                }
            }
        } message: {
            Text(pr.verdict == .ready ? method.landing(on: pr.baseRefName)
                : "\(method.landing(on: pr.baseRefName)) \(readiness(pr).label), so GitHub may refuse it.")
        }
    }
}

private struct CheckRow: View {
    let check: PrCheck

    var body: some View {
        let row = HStack(spacing: Theme.Space.m) {
            Group {
                switch check.state {
                case "success": Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.raised, Theme.add)
                case "failure": Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.raised, Theme.destructive)
                case "pending": ChecksSpinner(size: 20)
                default: Image(systemName: "minus.circle").foregroundStyle(Theme.tertiary)
                }
            }
            .font(Theme.Font.title.font)
            .frame(width: 20)
            Text(check.name).font(Theme.Font.body).foregroundStyle(Theme.text).lineLimit(1)
            Spacer(minLength: 0)
            if check.url != nil { OutArrow() }
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        if let url = check.url.flatMap(URL.init(string:)) {
            Link(destination: url) { row }
        } else {
            row
        }
    }
}

/// "Opens on GitHub", trailing a row that does.
private struct OutArrow: View {
    var body: some View {
        Image(systemName: "arrow.up.right").font(Theme.Font.footnote.font).foregroundStyle(Theme.tertiary)
    }
}

/// A comment or review as a card; tapping it opens the thread on GitHub,
/// since the sheet reads and never replies.
private struct CommentCard: View {
    let comment: PrComment

    var body: some View {
        let card = VStack(alignment: .leading, spacing: Theme.Space.s) {
            HStack(spacing: Theme.Space.s) {
                AsyncImage(url: comment.avatar.flatMap(URL.init(string:))) { $0.resizable() } placeholder: {
                    Circle().fill(Theme.tile)
                }
                .frame(width: 20, height: 20)
                .clipShape(Circle())
                Text(comment.author).foregroundStyle(Theme.text).lineLimit(1)
                if let verb { Text(verb).foregroundStyle(verbColor).lineLimit(1) }
                Spacer(minLength: 0)
                if comment.resolved { Text("Resolved").foregroundStyle(Theme.tertiary) }
                OutArrow()
            }
            .font(Theme.Font.subhead)
            if let path = comment.path {
                Text((path as NSString).lastPathComponent).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
            }
            let text = commentText(comment.body)
            if !text.isEmpty {
                // Verbatim: markdown would set inline code in monospace, which nothing here draws.
                Text(verbatim: text).font(Theme.Font.subhead).foregroundStyle(Theme.secondary).lineLimit(3)
                    .multilineTextAlignment(.leading)
            }
            if !comment.replies.isEmpty {
                Text("\(comment.replies.count) more").font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
            }
        }
        .padding(14)
        .prGroup(padding: 0)
        .opacity(comment.resolved ? 0.6 : 1)
        if let url = URL(string: comment.url) {
            Link(destination: url) { card }.buttonStyle(RowButtonStyle())
        } else {
            card
        }
    }

    private var verb: String? {
        switch comment.kind {
        case "approved": "approved"
        case "changes_requested": "requested changes"
        case "reviewed": "reviewed"
        default: nil
        }
    }

    private var verbColor: Color {
        switch comment.kind {
        case "approved": Theme.add
        case "changes_requested": Theme.destructive
        default: Theme.secondary
        }
    }
}

/// `gh` missing or logged out on the server: the command to run there, and a
/// way to look again once it has run. The desktop's `MissingCli`.
private struct MissingCli: View {
    @Environment(Store.self) private var store
    let kind: String
    let model: PrModel
    @State private var copied = false
    @State private var checking = false
    @State private var stillMissing = false

    var body: some View {
        let installing = kind == "no_cli"
        let command = installing ? "dray setup" : "gh auth login"
        let server = store.name(of: model.key.server)
        PrNotice(title: installing ? "GitHub CLI isn't installed" : "GitHub CLI is logged out",
                 message: stillMissing ? "Still not found on \(server)." : "Run this on \(server), then check again.") {
            PrOutline(tone: Theme.accent)
        } actions: {
            Button {
                UIPasteboard.general.string = command
                Haptic.tap()
                copied = true
            } label: {
                HStack(spacing: Theme.Space.m) {
                    Text(command).font(Theme.Font.footnote).foregroundStyle(Theme.text)
                    Spacer(minLength: 0)
                    Image(systemName: copied ? "checkmark" : "square.on.square")
                        .font(Theme.Font.subhead.font)
                        .foregroundStyle(Theme.secondary)
                }
                .padding(.vertical, Theme.Space.m)
                .padding(.horizontal, 14)
                .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous))
            }
            .buttonStyle(RowButtonStyle())
            .accessibilityLabel("Copy \(command)")
            .padding(.top, 6)

            Button {
                Task { await recheck(installing) }
            } label: {
                Text("Check again").frame(maxWidth: .infinity)
            }
            .buttonStyle(CapsuleButtonStyle(height: 48))
            .disabled(checking)
        }
    }

    /// Logging in moves nothing about where `gh` is, so that half only reads again;
    /// an install needs the server to drop its cached absence first.
    private func recheck(_ installing: Bool) async {
        checking = true
        defer { checking = false }
        if installing {
            let found = (try? await store.call(model.key.server, "recheck_gh", as: Bool.self)) ?? false
            stillMissing = !found
            if !found { return }
        }
        await model.load(store)
    }
}

/// A centred mark, title and sentence, set high on the sheet, with whatever answers it below.
private struct PrNotice<Mark: View, Actions: View>: View {
    let title: String
    let message: String
    @ViewBuilder let mark: Mark
    @ViewBuilder let actions: Actions

    var body: some View {
        VStack(spacing: 14) {
            mark
            VStack(spacing: Theme.Space.xs) {
                Text(title).font(Theme.Font.title).foregroundStyle(Theme.text)
                Text(.init(message)).font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
            }
            .multilineTextAlignment(.center)
            .padding(.horizontal, Theme.Space.m)
            actions
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 120)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The open-PR glyph at notice size in one tone; `dashed` draws the half a
/// PR would complete, for a branch that has none yet.
private struct PrOutline: View {
    let tone: Color
    var dashed = false

    var body: some View {
        Canvas { ctx, box in
            ctx.scaleBy(x: box.width / 24, y: box.height / 24)
            var base = Path()
            base.addEllipse(in: CGRect(x: 3, y: 3, width: 6, height: 6))
            base.move(to: CGPoint(x: 6, y: 9))
            base.addLine(to: CGPoint(x: 6, y: 21))
            var head = Path()
            head.addEllipse(in: CGRect(x: 15, y: 15, width: 6, height: 6))
            head.move(to: CGPoint(x: 13, y: 6))
            head.addLine(to: CGPoint(x: 16, y: 6))
            head.addArc(center: CGPoint(x: 16, y: 8), radius: 2, startAngle: .degrees(270), endAngle: .degrees(0), clockwise: false)
            head.addLine(to: CGPoint(x: 18, y: 15))
            ctx.stroke(base, with: .color(tone), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            ctx.stroke(head, with: .color(tone), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: dashed ? [2.5, 2] : []))
        }
        .frame(width: 36, height: 36)
        .accessibilityHidden(true)
    }
}

/// The ready sheet's shape with no words in it, while GitHub is first asked.
private struct PrSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.raised).frame(width: 20, height: 20)
                        bone(250, 16, Theme.raised)
                    }
                    bone(170, 12, Theme.raised).padding(.leading, 30)
                }
                .padding(.top, Theme.Space.xs)
                VStack(alignment: .leading, spacing: 14) {
                    bone(150, 12)
                    Capsule().fill(Theme.tile).frame(height: 44).opacity(0.6)
                }
                .padding(Theme.Space.l)
                .prGroup(padding: 0)
            }
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                bone(52, 10, Theme.raised).padding(.leading, Theme.Space.xs)
                VStack(spacing: 0) {
                    ForEach([110, 80, 130], id: \.self) { w in
                        HStack(spacing: Theme.Space.m) {
                            Circle().fill(Theme.tile).frame(width: 18, height: 18)
                            bone(CGFloat(w), 12)
                        }
                        .padding(.horizontal, Theme.Space.l)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .opacity(w == 130 ? 0.6 : 1)
                    }
                }
                .padding(.vertical, Theme.Space.xs)
                .prGroup(padding: 0)
            }
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                bone(72, 10, Theme.raised).padding(.leading, Theme.Space.xs)
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: Theme.Space.s) {
                        Circle().fill(Theme.tile).frame(width: 20, height: 20)
                        bone(96, 12)
                    }
                    bone(290, 10)
                    bone(200, 10)
                }
                .padding(14)
                .prGroup(padding: 0)
            }
            .opacity(0.6)
        }
        .accessibilityHidden(true)
    }

    private func bone(_ width: CGFloat, _ height: CGFloat, _ fill: Color = Theme.tile) -> some View {
        Capsule().fill(fill).frame(width: width, height: height)
    }
}

private extension View {
    /// A raised group on the sheet: the readiness card, the checks, each comment.
    func prGroup(padding: CGFloat = Theme.Space.l) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
    }
}
