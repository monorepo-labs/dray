import SwiftUI

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
                        Button("Pull request", systemImage: "arrow.triangle.pull") { showing = true }
                            .tint(model.prs.first.map(stateColor))
                    }
                }
            }
            .sheet(isPresented: $showing) { PrSheet(model: model) }
    }
}

private func stateColor(_ pr: PullRequest) -> Color {
    switch pr.state {
    case "MERGED": .purple
    case "CLOSED": .red
    default: pr.isDraft ? .secondary : .green
    }
}

struct PrSheet: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    let model: PrModel

    var body: some View {
        NavigationStack {
            List {
                if let u = model.unavailable {
                    Text(.init(u.sentence))
                        .foregroundStyle(u.keepsButton ? Color.secondary : Color.red)
                }
                if let e = model.actionError {
                    Text(e).foregroundStyle(.red)
                }
                ForEach(model.prs) { pr in
                    PrSection(pr: pr, model: model)
                }
            }
            .navigationTitle(model.branch ?? "Pull request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .refreshable { await model.load(store) }
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

private struct PrSection: View {
    @Environment(Store.self) private var store
    let pr: PullRequest
    let model: PrModel
    @State private var merging = false

    var body: some View {
        let ready = readiness(pr)
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Link(destination: URL(string: pr.url) ?? URL(string: "https://github.com")!) {
                    Text(pr.title).font(.headline).multilineTextAlignment(.leading)
                }
                Text("#\(pr.number) · \(pr.author) · +\(pr.additions) −\(pr.deletions) · \(pr.changedFiles) files")
                    .font(.caption).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(ready.label).font(.subheadline.weight(.medium)).foregroundStyle(tone)
                    if pr.state == "OPEN" {
                        Text("into \(pr.baseRefName)").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                if let detail = ready.detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            action
        }
        if !pr.checks.isEmpty {
            Section("Checks") {
                ForEach(pr.checks, id: \.self) { CheckRow(check: $0) }
            }
        }
        if !pr.comments.isEmpty {
            Section("Comments") {
                // Keyed on the url, so a new reply or an edit keeps an open thread open.
                ForEach(pr.comments, id: \.url) { CommentRow(comment: $0) }
            }
        }
    }

    private var tone: Color {
        switch pr.verdict {
        case .ready: .green
        case .conflict: .red
        case .behind, .blocked, .unstable, .unknown: .orange
        case .merged, .closed, .draft: .secondary
        }
    }

    /// Reopen, mark ready, or merge — and no close or branch delete, as on the desktop.
    @ViewBuilder private var action: some View {
        if model.acting {
            HStack { Orb(); Text("Working…").foregroundStyle(.secondary) }
        } else if pr.state == "CLOSED" {
            Button("Reopen") { Task { await model.act(store, "reopen_pr", pr.number) } }
        } else if pr.state == "OPEN" && pr.isDraft {
            Button("Ready for review") { Task { await model.act(store, "mark_pr_ready", pr.number) } }
        } else if pr.state == "OPEN" {
            // One dialog is both the pick and the confirm: merging is the one thing here that cannot be undone.
            Button("Merge…") { merging = true }
                .confirmationDialog("Merge #\(pr.number)?", isPresented: $merging, titleVisibility: .visible) {
                    ForEach([("squash", "Squash and merge"), ("merge", "Create a merge commit"), ("rebase", "Rebase and merge")], id: \.0) { method, label in
                        Button(label) { Task { await model.act(store, "merge_pr", pr.number, ["method": .string(method)]) } }
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
        let row = HStack(spacing: 8) {
            switch check.state {
            case "success": Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            case "failure": Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
            case "pending": Orb()
            default: Image(systemName: "minus.circle").foregroundStyle(.secondary)
            }
            Text(check.name).lineLimit(1)
        }
        if let url = check.url.flatMap(URL.init(string:)) {
            Link(destination: url) { row }.foregroundStyle(.primary)
        } else {
            row
        }
    }
}

private struct CommentRow: View {
    let comment: PrComment
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                AsyncImage(url: comment.avatar.flatMap(URL.init(string:))) { $0.resizable() } placeholder: {
                    Circle().fill(.fill.tertiary)
                }
                .frame(width: 18, height: 18)
                .clipShape(Circle())
                Text(comment.author).font(.subheadline.weight(.medium))
                if let verb { Text(verb).font(.caption).foregroundStyle(verbColor) }
                if comment.resolved { Text("Resolved").font(.caption).foregroundStyle(.secondary) }
            }
            if let path = comment.path {
                Text((path as NSString).lastPathComponent).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            let text = commentText(comment.body)
            if !text.isEmpty {
                if open { MarkdownText(text: text) } else { Text(.init(text)).lineLimit(3) }
            }
            if open {
                ForEach(comment.replies, id: \.url) { CommentRow(comment: $0).padding(.leading, 12) }
            } else if !comment.replies.isEmpty {
                Text("\(comment.replies.count) more").font(.caption).foregroundStyle(.secondary)
            }
        }
        .font(.callout)
        .opacity(comment.resolved && !open ? 0.6 : 1)
        .contentShape(Rectangle())
        .onTapGesture { open.toggle() }
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
        case "approved": .green
        case "changes_requested": .red
        default: .secondary
        }
    }
}
