import SwiftUI
import ThinkingOrbs

extension EnvironmentValues {
    /// A settled task opened from a PR's page: its chat, and no dock to write in.
    @Entry var readOnly = false
}

/// A pull request picked on the pull requests page: what it is — state, people,
/// branches, labels, reviewers and its description, the issue page's shape —
/// then every task it has had, newest first, and the PR sheet's own rows. Play
/// opens the sheet that starts another task on the PR's own branch, the reader's
/// or a bot's. The list's row draws the head at once; the reads fill in the rest.
struct PullDetailView: View {
    @Environment(Store.self) private var store
    let row: PullRow
    @State private var model: PrModel
    @State private var starting = false
    @State private var opening: SessionKey?
    @State private var detail: PrDetail?
    @State private var detailFailure: String?

    init(row: PullRow) {
        self.row = row
        _model = State(initialValue: PrModel(server: row.server, cwd: row.key, branch: row.mark.headRefName))
        _detail = State(initialValue: PullsModel.shared.details[row.id])
    }

    var body: some View {
        // The read answers every PR on the head branch; this page is one.
        let pr = model.prs.first { $0.number == row.mark.number }
        let tasks = sessionsForPr(row, store.items.map { (key: $0.key, item: $0.value) }, repoOf: store.repoOf,
                                  connected: { store.serverState[$0] == .connected })
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: Theme.Space.xl) {
                    head(pr)
                    meta(pr)
                    description
                }
                if !tasks.isEmpty { taskList(tasks) }
                if let u = model.unavailable {
                    Text(.init(u.sentence)).font(Theme.Font.footnote).foregroundStyle(Theme.destructive)
                }
                if let e = model.actionError {
                    Text(sentence(e)).font(Theme.Font.footnote).foregroundStyle(Theme.destructive)
                }
                if let pr {
                    PrSection(pr: pr, model: model, header: false)
                } else if model.unavailable == nil {
                    reading("Reading the pull request…")
                }
            }
            // Full width whatever the content: a short line left the scroll view a narrow column (#1509).
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, Theme.Space.xxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .page()
        .navigationTitle("#\(String(row.mark.number)) · \(row.repoName.split(separator: "/").last.map(String.init) ?? "")")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Play waits on the PR's read: the task's prompt is made from it.
            DetailActions(link: row.mark.url.flatMap(URL.init(string:)), title: pr?.title ?? row.listing.title,
                          play: pr == nil ? nil : { starting = true })
        }
        .sheet(isPresented: $starting) {
            if let pr { StartTaskSheet(subject: .pr(row, pr), latest: tasks.first.flatMap { store.items[$0] }) }
        }
        .refreshable {
            async let detail: Void = readDetail()
            await model.load(store)
            await detail
        }
        .task { await readDetail() }
        // The PR sheet's poll: quicker while GitHub is still working something out.
        .task {
            while !Task.isCancelled {
                await model.load(store)
                try? await Task.sleep(for: .seconds(model.prs.contains(where: \.settling) ? 15 : 60))
            }
        }
        .navigationDestination(item: $opening) { key in
            TranscriptView(key: key).id(key).environment(\.readOnly, store.items[key]?.archived == true)
        }
    }

    /// The title over its state and number, as an issue's page leads.
    private func head(_ pr: PullRequest?) -> some View {
        let state = pr?.state ?? row.mark.state
        let draft = pr?.isDraft ?? row.mark.isDraft
        let label = state == "MERGED" ? "Merged" : state == "CLOSED" ? "Closed" : draft ? "Draft" : "Open"
        return VStack(alignment: .leading, spacing: Theme.Space.s) {
            Text(pr?.title ?? row.listing.title).font(Theme.Font.title).foregroundStyle(Theme.text)
            HStack(spacing: Theme.Space.s) {
                HStack(spacing: 6) {
                    PrGlyph(mark: pr?.mark ?? row.mark, size: 14)
                    Text(label)
                }
                .font(Theme.Font.subhead)
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(Theme.raised, in: Capsule())
                Text("#\(String(row.mark.number))").font(Theme.Font.subhead.font.monospacedDigit()).foregroundStyle(Theme.secondary)
            }
        }
    }

    /// Who opened it and when, where it lands, its size, labels and reviewers.
    private func meta(_ pr: PullRequest?) -> some View {
        let l = row.listing
        let opened = detail.flatMap { parseDate($0.createdAt) }.map { " · \(ago($0))" } ?? ""
        let updated = parseDate(pr?.updatedAt ?? l.updatedAt).map { "Updated \(ago($0))" }
        let files = pr.map { "\($0.changedFiles) \($0.changedFiles == 1 ? "file" : "files")" }
        return VStack(alignment: .leading, spacing: Theme.Space.s) {
            PersonLine(avatar: l.authorAvatar ?? detail?.authorAvatar) { Text("\(pr?.author ?? l.author) opened this\(opened)") }
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch").foregroundStyle(Theme.tertiary)
                // Base is read with the PR; until then the head alone.
                Text(pr.map { "\($0.baseRefName) ← \(row.mark.headRefName)" } ?? row.mark.headRefName)
                    .font(Theme.Font.footnote.font.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .font(Theme.Font.footnote)
            .foregroundStyle(Theme.secondary)
            HStack(spacing: 6) {
                Text("+\(pr?.additions ?? l.additions)").foregroundStyle(Theme.add)
                Text("−\(pr?.deletions ?? l.deletions)").foregroundStyle(Theme.destructive)
                Text(([files, updated].compactMap { $0 }).map { "· \($0)" }.joined(separator: " "))
            }
            .font(Theme.Font.footnote.font.monospacedDigit())
            .foregroundStyle(Theme.tertiary)
            .lineLimit(1)
            if let detail, !detail.labels.isEmpty { LabelChips(labels: detail.labels) }
            if let detail, !detail.reviewers.isEmpty { reviewers(detail.reviewers, decision: pr?.reviewDecision) }
        }
    }

    /// Each reviewer and where they stand, under the review decision GitHub holds the PR to.
    private func reviewers(_ list: [PrReviewer], decision: String?) -> some View {
        let said = ["requested": "awaiting review", "approved": "approved", "changes_requested": "requested changes", "commented": "commented"]
        return VStack(alignment: .leading, spacing: Theme.Space.s) {
            HStack {
                GroupLabel("Reviewers")
                Spacer()
                if decision == "REVIEW_REQUIRED" {
                    Text("Review required").font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                }
            }
            .padding(.top, Theme.Space.s)
            ForEach(list, id: \.self) { r in
                PersonLine(avatar: r.avatar) {
                    HStack(spacing: 4) {
                        Text(r.name).foregroundStyle(Theme.text)
                        Text(said[r.state] ?? r.state.replacingOccurrences(of: "_", with: " "))
                            .foregroundStyle(r.state == "approved" ? Theme.add : r.state == "changes_requested" ? Theme.destructive : Theme.tertiary)
                    }
                    .lineLimit(1)
                }
            }
        }
    }

    @ViewBuilder private var description: some View {
        if let detail {
            let text = prBody(detail.body)
            if text.isEmpty {
                Text("No description.").font(Theme.Font.subhead).foregroundStyle(Theme.tertiary)
            } else {
                MarkdownText(text: text)
            }
        } else if let detailFailure {
            Text(sentence(detailFailure)).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
        } else {
            reading("Reading the description…")
        }
    }

    private func reading(_ line: String) -> some View {
        HStack(spacing: Theme.Space.s) {
            Orb(.working)
            Text(line).font(Theme.Font.subhead).foregroundStyle(Theme.secondary).shimmer()
        }
    }

    private func ago(_ date: Date) -> String {
        let age = shortAge(date)
        return age == "now" ? "just now" : "\(age) ago"
    }

    /// The description, labels and reviewers; a server from before `pr_detail` says so in place of the text.
    private func readDetail() async {
        do {
            let read: PrDetail = try await store.call(row.server, "pr_detail", ["cwd": .string(row.key), "number": JSON(row.mark.number)])
            detail = read
            detailFailure = nil
            PullsModel.shared.details[row.id] = read
        } catch {
            guard detail == nil else { return }
            let said = error.localizedDescription
            detailFailure = said.contains("unknown command")
                ? "\(store.name(of: row.server)) is too old to send the description. Update it to see it here."
                : PrUnavailable.from(error).sentence
        }
    }

    /// The PR's tasks, newest first. A settled one still opens: its work and conversation are there.
    private func taskList(_ tasks: [SessionKey]) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            GroupLabel(tasks.count == 1 ? "Task" : "Tasks")
            VStack(spacing: 0) {
                ForEach(Array(tasks.enumerated()), id: \.element) { i, key in
                    if i > 0 { PickDivider() }
                    if let item = store.items[key] {
                        let bot = store.botOf(key)
                        Button { opening = key } label: {
                            HStack(spacing: Theme.Space.s) {
                                if let bot { BotFace(bot: bot, size: 18) }
                                Text(bot.map { "\($0.name) · \(item.title)" } ?? item.title)
                                    .foregroundStyle(item.archived == true ? Theme.secondary : Theme.text)
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                if item.archived == true { Text("Settled").foregroundStyle(Theme.tertiary) }
                                else if item.busy { Orb(.working) }
                                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.tertiary)
                            }
                            .font(Theme.Font.body)
                            .rowFrame()
                        }
                        .buttonStyle(RowButtonStyle())
                    }
                }
            }
            .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
        }
    }
}
