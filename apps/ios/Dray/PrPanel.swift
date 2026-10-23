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
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.xl) {
                    if let u = model.unavailable {
                        Text(.init(u.sentence))
                            .font(Theme.Font.callout)
                            .foregroundStyle(u.keepsButton ? Theme.secondary : Theme.destructive)
                    }
                    if let e = model.actionError {
                        Label(sentence(e), systemImage: "exclamationmark.circle.fill")
                            .font(Theme.Font.callout)
                            .foregroundStyle(Theme.destructive)
                    }
                    ForEach(model.prs) { pr in
                        PrSection(pr: pr, model: model)
                    }
                }
                .padding(Theme.Space.l)
            }
            .page()
            .refreshable { await model.load(store) }
            .navigationTitle(model.branch ?? "Pull request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() }.fontWeight(.semibold) }
        }
        // The desktop's poll: quicker while GitHub is still working something out.
        .task {
            while !Task.isCancelled {
                await model.load(store)
                try? await Task.sleep(for: .seconds(model.prs.contains(where: \.settling) ? 15 : 60))
            }
        }
    }
}

/// One pull request: what it is, whether it can land and the one action that
/// moves it, then its checks and what people said, separated by space alone.
private struct PrSection: View {
    @Environment(Store.self) private var store
    let pr: PullRequest
    let model: PrModel
    @State private var merging = false

    var body: some View {
        let ready = readiness(pr)
        VStack(alignment: .leading, spacing: Theme.Space.xl) {
            VStack(alignment: .leading, spacing: Theme.Space.m) {
                Link(destination: URL(string: pr.url) ?? URL(string: "https://github.com")!) {
                    HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                        PrGlyph(mark: pr.mark, size: 18).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
                        Text(pr.title)
                            .font(Theme.Font.title)
                            .foregroundStyle(Theme.text)
                            .multilineTextAlignment(.leading)
                    }
                }
                HStack(spacing: 6) {
                    Text("#\(pr.number) · \(pr.author)")
                    ChangeCount(added: pr.additions, removed: pr.deletions)
                    Text("· \(pr.changedFiles) \(pr.changedFiles == 1 ? "file" : "files")")
                }
                .font(Theme.Font.meta)
                .foregroundStyle(Theme.secondary)

                VStack(alignment: .leading, spacing: Theme.Space.m) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(ready.label).font(Theme.Font.callout.weight(.semibold)).foregroundStyle(tone)
                        if pr.state == "OPEN" {
                            Text("into \(pr.baseRefName)").font(Theme.Font.mono).foregroundStyle(Theme.tertiary).lineLimit(1)
                        }
                    }
                    if let detail = ready.detail {
                        Text(detail).font(Theme.Font.meta).foregroundStyle(Theme.secondary)
                    }
                    action
                }
                .card()
            }

            if !pr.checks.isEmpty {
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    GroupLabel("Checks")
                    VStack(spacing: 0) {
                        ForEach(Array(pr.checks.enumerated()), id: \.element) { i, check in
                            if i > 0 { Divider().overlay(Theme.hairline).padding(.leading, 44) }
                            CheckRow(check: check)
                        }
                    }
                    .card(padding: 0)
                }
            }
            if !pr.comments.isEmpty {
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    GroupLabel("Comments")
                    VStack(spacing: Theme.Space.s) {
                        ForEach(pr.comments) { CommentRow(comment: $0).card(padding: Theme.Space.m) }
                    }
                }
            }
        }
    }

    private var tone: Color {
        switch pr.verdict {
        case .ready: Theme.add
        case .conflict: Theme.destructive
        case .behind, .blocked, .unstable, .unknown: Theme.accent
        case .merged: Theme.merged
        case .closed, .draft: Theme.secondary
        }
    }

    /// Reopen, mark ready, or merge — and no close or branch delete, as on the desktop.
    @ViewBuilder private var action: some View {
        if model.acting {
            HStack(spacing: Theme.Space.s) {
                Orb(.working)
                Text("Working…").font(Theme.Font.callout).foregroundStyle(Theme.secondary).shimmer()
            }
            .frame(minHeight: 44)
        } else if pr.state == "CLOSED" {
            Button { Task { await model.act(store, "reopen_pr", pr.number) } } label: {
                Text("Reopen").frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryButtonStyle())
        } else if pr.state == "OPEN" && pr.isDraft {
            Button { Task { await model.act(store, "mark_pr_ready", pr.number) } } label: {
                Text("Ready for review").frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
        } else if pr.state == "OPEN" {
            // GitHub's green, never disabled: the readiness line above is why it may refuse.
            Button { merging = true } label: { Text("Merge…").frame(maxWidth: .infinity) }
                .buttonStyle(PrimaryButtonStyle(fill: Theme.merge, ink: .white))
                .opacity(pr.verdict == .ready ? 1 : 0.6)
                // One dialog is both the pick and the confirm: merging is the one thing here that cannot be undone.
                .confirmationDialog("Merge #\(pr.number)?", isPresented: $merging, titleVisibility: .visible) {
                    ForEach([("squash", "Squash and merge"), ("merge", "Create a merge commit"), ("rebase", "Rebase and merge")], id: \.0) { method, label in
                        Button(label) {
                            Task {
                                await model.act(store, "merge_pr", pr.number, ["method": .string(method)])
                                model.actionError == nil ? Haptic.success() : Haptic.error()
                            }
                        }
                    }
                } message: {
                    Text(pr.verdict == .ready ? "Into \(pr.baseRefName)." : "\(readiness(pr).label). GitHub may refuse it.")
                }
        }
    }
}

private struct CheckRow: View {
    let check: PrCheck

    var body: some View {
        let row = HStack(spacing: Theme.Space.m) {
            Group {
                switch check.state {
                case "success": Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.add)
                case "failure": Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.destructive)
                case "pending": ChecksSpinner()
                default: Image(systemName: "minus.circle").foregroundStyle(Theme.tertiary)
                }
            }
            .frame(width: 20)
            Text(check.name).font(Theme.Font.callout).foregroundStyle(Theme.text).lineLimit(1)
            Spacer(minLength: 0)
            if check.url != nil {
                Image(systemName: "arrow.up.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.tertiary)
            }
        }
        .padding(.horizontal, Theme.Space.m)
        .frame(minHeight: 44)
        if let url = check.url.flatMap(URL.init(string:)) {
            Link(destination: url) { row }
        } else {
            row
        }
    }
}

private struct CommentRow: View {
    let comment: PrComment
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            HStack(spacing: Theme.Space.s) {
                AsyncImage(url: comment.avatar.flatMap(URL.init(string:))) { $0.resizable() } placeholder: {
                    Circle().fill(Theme.raised)
                }
                .frame(width: 20, height: 20)
                .clipShape(Circle())
                Text(comment.author).font(Theme.Font.callout.weight(.semibold)).foregroundStyle(Theme.text)
                if let verb { Text(verb).font(Theme.Font.meta).foregroundStyle(verbColor) }
                Spacer(minLength: 0)
                if comment.resolved { Text("Resolved").font(Theme.Font.micro).foregroundStyle(Theme.tertiary) }
            }
            if let path = comment.path {
                Text((path as NSString).lastPathComponent).font(Theme.Font.code).foregroundStyle(Theme.tertiary)
            }
            let text = commentText(comment.body)
            if !text.isEmpty {
                if open { MarkdownText(text: text) } else {
                    Text(.init(text)).font(Theme.Font.callout).foregroundStyle(Theme.secondary).lineLimit(3)
                }
            }
            if open {
                ForEach(comment.replies) {
                    CommentRow(comment: $0)
                        .padding(.leading, Theme.Space.m)
                        .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 1) }
                }
            } else if !comment.replies.isEmpty {
                Text("\(comment.replies.count) more").font(Theme.Font.meta).foregroundStyle(Theme.tertiary)
            }
        }
        .opacity(comment.resolved && !open ? 0.6 : 1)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(Theme.motion) { open.toggle() } }
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
