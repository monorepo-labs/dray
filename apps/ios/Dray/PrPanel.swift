import SwiftUI
import ThinkingOrbs

/// What the server says about a session's pull requests. Lives in the session
/// view, so the toolbar button knows whether there is anything to open.
@MainActor @Observable
final class PrModel {
    let server: UUID
    /// The session whose branch it reads; `nil` reads `cwd` and `branch` as given, the pull requests page's way.
    let key: SessionKey?
    var cwd: String?
    var prs: [PullRequest] = []
    var unavailable: PrUnavailable?
    var branch: String?
    var acting = false
    var actionError: String?
    @ObservationIgnored private var generation = 0

    init(key: SessionKey) {
        server = key.server
        self.key = key
    }

    init(server: UUID, cwd: String, branch: String) {
        self.server = server
        key = nil
        self.cwd = cwd
        self.branch = branch
    }

    /// The button stays for the two states the reader can fix; every other
    /// error with no rows hides it, as the desktop's tab does.
    var visible: Bool { !prs.isEmpty || unavailable?.keepsButton == true }

    func load(_ store: Store) async {
        generation += 1
        let gen = generation
        do {
            if let key {
                guard let item = store.items[key] else { return }
                let status: WorkStatus = try await store.call(server, "work_status", ["cwd": .string(item.cwd)])
                cwd = item.cwd
                branch = sessionBranch(branch: item.branch, worktreeName: item.worktreeName,
                                       worktreeRemoved: item.worktreeRemoved ?? false, observed: status.branch)
            }
            guard let cwd, let branch else {
                if gen == generation { (prs, unavailable) = ([], nil) }
                return
            }
            let prs: [PullRequest] = try await store.call(server, "prs_for_branch",
                                                          ["cwd": .string(cwd), "branch": .string(branch)])
            guard gen == generation else { return }
            (self.prs, unavailable) = (prs, nil)
        } catch {
            // Rows already on screen stay under the sentence, which says what failed to update.
            guard gen == generation else { return }
            unavailable = PrUnavailable.from(error)
        }
    }

    func act(_ store: Store, _ cmd: String, _ number: Int, _ extra: [String: JSON] = [:]) async {
        guard let cwd = key.flatMap({ store.items[$0]?.cwd }) ?? cwd else { return }
        acting = true
        actionError = nil
        do {
            let _: JSON = try await store.call(server, cmd, ["cwd": .string(cwd), "number": JSON(number)].merging(extra) { $1 })
        } catch {
            actionError = error.localizedDescription
        }
        await load(store)
        if let path = key.flatMap({ store.items[$0]?.projectPath }) ?? self.cwd { await store.refreshMarks(server, path) }
        acting = false
    }
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

    private let key: SessionKey

    init(key: SessionKey) {
        self.key = key
        _model = State(initialValue: PrModel(key: key))
    }

    func body(content: Content) -> some View {
        let busy = store.items[key]?.busy ?? false
        let connected = store.serverState[key.server] == .connected
        content
            // On arrival, on every turn edge, and on reconnect, where a read
            // that failed with the socket down would otherwise never retry.
            .task(id: "\(busy)|\(connected)") { if connected { await model.load(store) } }
            .toolbar {
                // A bot's folder holds notes, not work: no PR lookup there, as on the desktop.
                if model.visible && store.bot(key) == nil {
                    ToolbarItem(placement: .primaryAction) {
                        // The list row's own glyph, so the button says the PR's state before it is opened.
                        Button { showing = true } label: {
                            if let pr = model.prs.first {
                                PrGlyph(mark: pr.mark, size: 20)
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
        // No loading or no-PR state: the button that opens this shows only once a read found one.
        if model.prs.isEmpty, let u = model.unavailable, u.keepsButton {
            MissingCli(kind: u.kind, model: model)
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
/// moves it, then its checks and what people said. With `picked`, each comment
/// and inline thread carries a box, the pull requests page's way of quoting
/// them to the task it starts.
struct PrSection: View {
    @Environment(Store.self) private var store
    let pr: PullRequest
    let model: PrModel
    var picked: Binding<Set<String>>? = nil
    /// Off on the pull requests page, whose own head names the PR.
    var header = true

    var body: some View {
        let ready = readiness(pr)
        VStack(alignment: .leading, spacing: 28) {
            VStack(alignment: .leading, spacing: 14) {
                if header { VStack(alignment: .leading, spacing: 6) {
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
                        Text("#\(String(pr.number)) · \(pr.author)").foregroundStyle(Theme.secondary)
                        Text("+\(pr.additions)").foregroundStyle(Theme.add)
                        Text("−\(pr.deletions)").foregroundStyle(Theme.destructive)
                        Text("· \(pr.changedFiles) \(pr.changedFiles == 1 ? "file" : "files")").foregroundStyle(Theme.secondary)
                    }
                    .font(Theme.Font.footnote)
                    .lineLimit(1)
                    .padding(.leading, 30)
                } }

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
                    HStack {
                        GroupLabel("Comments")
                        Spacer()
                        if let picked { pickButton(picked) }
                    }
                    ForEach(pr.comments) { c in
                        CommentCard(comment: c, picked: picked)
                        // Picking reaches into a review: each inline thread is a unit of its own.
                        if picked != nil {
                            ForEach(c.threads) { CommentCard(comment: $0, picked: picked).padding(.leading, Theme.Space.xl) }
                        }
                    }
                }
            }
        }
    }

    /// Select unresolved while nothing is picked, Clear once something is.
    @ViewBuilder private func pickButton(_ picked: Binding<Set<String>>) -> some View {
        let unresolved = unresolvedKeys(pr.comments)
        if !picked.wrappedValue.isEmpty {
            Button("Clear \(picked.wrappedValue.count)") { picked.wrappedValue = [] }
                .font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
        } else if !unresolved.isEmpty {
            Button("Select unresolved (\(unresolved.count))") {
                Haptic.select()
                picked.wrappedValue = Set(unresolved)
            }
            .font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
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
        if done < pr.checks.count { return "\(done) of \(pr.checks.count) done" }
        // Cancelled, skipped and neutral finish without passing.
        return pr.checks.allSatisfy { $0.state == "success" } ? "All passed" : "All done"
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
        // A poll can start or fail a check while the confirm is open; the hold covers it too.
        .onChange(of: pr.checksHold) { _, hold in if hold { confirming = false } }
        .confirmationDialog("\(method.label) #\(String(pr.number))?", isPresented: $confirming, titleVisibility: .visible) {
            Button(method.label) {
                // Read the model, not this view's copy, which can trail a refresh by a render.
                guard model.prs.first(where: { $0.number == pr.number })?.checksHold == false else { return }
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
    var picked: Binding<Set<String>>? = nil

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
        HStack(alignment: .top, spacing: Theme.Space.s) {
            if let picked { box(picked) }
            if let url = URL(string: comment.url) {
                Link(destination: url) { card }.buttonStyle(RowButtonStyle())
            } else {
                card
            }
        }
    }

    private func box(_ picked: Binding<Set<String>>) -> some View {
        let on = picked.wrappedValue.contains(comment.key)
        return Button {
            Haptic.select()
            if on { picked.wrappedValue.remove(comment.key) } else { picked.wrappedValue.insert(comment.key) }
        } label: {
            Image(systemName: on ? "checkmark.square.fill" : "square")
                .font(Theme.Font.title.font)
                .foregroundStyle(on ? Theme.text : Theme.tertiary)
                .frame(width: 28, height: 44)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Quote \(comment.author)'s comment")
        .accessibilityAddTraits(on ? .isSelected : [])
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
        let server = store.name(of: model.server)
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
            let found = (try? await store.call(model.server, "recheck_gh", as: Bool.self)) ?? false
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

/// The open-PR glyph at notice size, in one tone.
private struct PrOutline: View {
    let tone: Color

    var body: some View {
        Canvas { ctx, box in
            ctx.scaleBy(x: box.width / 24, y: box.height / 24)
            var p = Path()
            p.addEllipse(in: CGRect(x: 3, y: 3, width: 6, height: 6))
            p.move(to: CGPoint(x: 6, y: 9))
            p.addLine(to: CGPoint(x: 6, y: 21))
            p.addEllipse(in: CGRect(x: 15, y: 15, width: 6, height: 6))
            p.move(to: CGPoint(x: 13, y: 6))
            p.addLine(to: CGPoint(x: 16, y: 6))
            p.addArc(center: CGPoint(x: 16, y: 8), radius: 2, startAngle: .degrees(270), endAngle: .degrees(0), clockwise: false)
            p.addLine(to: CGPoint(x: 18, y: 15))
            ctx.stroke(p, with: .color(tone), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
        }
        .frame(width: 36, height: 36)
        .accessibilityHidden(true)
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
