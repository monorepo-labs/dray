import SwiftUI

// MARK: Wire

/// `git.rs`'s `ChangedFile`: one path between two snapshots, with git's own numstat counts.
struct ChangedFile: Decodable, Hashable {
    let path: String
    /// A rename's name in the old snapshot, which its old side is read under.
    let oldPath: String?
    /// `added`, `modified`, `deleted` or `renamed`.
    let status: String
    let added: Int
    let removed: Int
    let binary: Bool
}

/// `changes_since`' answer. `head` is the snapshot the read took, which a file's
/// diff must be read against, or a moving working tree shows a diff the list never counted.
struct ChangeSet: Decodable {
    let base: String
    let head: String
    let files: [ChangedFile]
    let added: Int
    let removed: Int
}

/// `file_change`'s answer: both sides of one file, or why a side is withheld.
struct FileVersions: Decodable {
    let oldText: String?
    let newText: String?
    /// `binary` or `too_large`.
    let unreadable: String?
}

struct Commit: Decodable, Hashable, Identifiable {
    let sha: String
    /// None on a root commit, which diffs against the empty tree.
    let parent: String?
    let subject: String
    let body: String
    let author: String
    let authoredAt: String
    var id: String { sha }
    var base: String { parent ?? emptyTree }
}

/// Git's empty tree, the base of a root commit, as in `commit.ts`.
let emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/// The desktop's `changeRange` over the events held: the newest prompt's
/// baseline to the head its turn closed on, skipping turns that changed
/// nothing. Open-ended only while that turn still runs; a turn left open
/// otherwise is skipped, since diffing it against now takes in whatever else
/// touched the checkout since. Falls back to the newest turn, which then
/// reads as nothing changed.
func lastTurnRange(_ events: [AgentEvent], running: Bool) -> (base: String, head: String?)? {
    var head: String?
    var newest: (base: String, head: String?)?
    for e in events.reversed() {
        if case .turnCompleted = e.payload, head == nil, let t = e.tree { head = t }
        guard case .userMessage = e.payload, let base = e.tree else { continue }
        let range = (base: base, head: head)
        let first = newest == nil
        head = nil
        if first { newest = range }
        if range.head == range.base { continue }
        if range.head == nil && !(running && first) { continue }
        return range
    }
    return newest
}

// MARK: Unified diff

enum DiffRow: Hashable {
    /// `number` is the new side's line, or the old side's on a removal.
    case line(sign: Character, number: Int, text: String)
    /// Unchanged lines folded out between hunks.
    case gap(Int)
}

/// A unified diff with `context` lines around each change, from the
/// standard library's own Myers difference.
func unifiedDiff(old: String?, new: String?, context: Int = 3) -> [DiffRow] {
    func lines(_ s: String?) -> [String] {
        guard let s, !s.isEmpty else { return [] }
        var all = s.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if s.hasSuffix("\n") { all.removeLast() }
        return all
    }
    let a = lines(old), b = lines(new)
    var removed = Set<Int>(), inserted = Set<Int>()
    for change in b.difference(from: a) {
        switch change {
        case .remove(let i, _, _): removed.insert(i)
        case .insert(let i, _, _): inserted.insert(i)
        }
    }
    // Lines neither side touched pair up one to one, in order.
    var all: [DiffRow] = []
    var i = 0, j = 0
    while i < a.count || j < b.count {
        if i < a.count, removed.contains(i) {
            all.append(.line(sign: "-", number: i + 1, text: a[i])); i += 1
        } else if j < b.count, inserted.contains(j) {
            all.append(.line(sign: "+", number: j + 1, text: b[j])); j += 1
        } else {
            all.append(.line(sign: " ", number: j + 1, text: b[j])); i += 1; j += 1
        }
    }
    var keep = [Bool](repeating: false, count: all.count)
    for (k, row) in all.enumerated() {
        guard case .line(let sign, _, _) = row, sign != " " else { continue }
        for n in max(0, k - context)...min(all.count - 1, k + context) { keep[n] = true }
    }
    var out: [DiffRow] = []
    var folded = 0
    for (k, row) in all.enumerated() {
        if keep[k] {
            if folded > 0 { out.append(.gap(folded)); folded = 0 }
            out.append(row)
        } else {
            folded += 1
        }
    }
    // Trailing unchanged lines go unsaid, as git leaves them.
    return out
}

// MARK: Screens

extension View {
    /// The Changes button in a session's top bar, and the screen it pushes.
    func changesButton(_ key: SessionKey, shown: Bool) -> some View { modifier(ChangesButton(key: key, shown: shown)) }
}

private struct ChangesButton: ViewModifier {
    let key: SessionKey
    let shown: Bool
    @State private var open = false

    func body(content: Content) -> some View {
        content
            .toolbar {
                if shown {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Changes", systemImage: "plus.forwardslash.minus") { open = true }
                    }
                }
            }
            .navigationDestination(isPresented: $open) { ChangesScreen(key: key) }
    }
}

private enum ChangesTab: String, CaseIterable {
    case turn = "Last turn", uncommitted = "Uncommitted", branch = "Branch", commits = "Commits"
}

/// What the agent changed, four ways: its last turn, the uncommitted tree,
/// the whole branch since it forked, and the history a commit at a time.
/// Reads only, as the desktop's repo view does.
struct ChangesScreen: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    @State private var tab = ChangesTab.turn

    var body: some View {
        let busy = store.items[key]?.busy ?? false
        VStack(spacing: 0) {
            Picker("Show", selection: $tab) {
                ForEach(ChangesTab.allCases, id: \.self) { Text($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Theme.Space.l)
            .padding(.vertical, Theme.Space.s)

            switch tab {
            case .turn:
                ChangeList(key: key, reload: "turn|\(busy)|\(store.transcripts[key]?.events.last?.id ?? "")",
                           nothing: ("Nothing to compare", "No turn in this session took a snapshot of the folder."),
                           clean: ("No changes", "The last turn didn't change any files.")) { store, cwd in
                    guard let r = lastTurnRange(store.transcripts[key]?.events ?? [], running: busy) else { return nil }
                    return try await store.call(key.server, "changes_since",
                                                ["cwd": .string(cwd), "baseline": .string(r.base), "head": JSON(r.head)])
                }
            case .uncommitted:
                ChangeList(key: key, reload: "work|\(busy)",
                           nothing: ("Not a repository", "This folder isn't tracked by git."),
                           clean: ("Nothing uncommitted", "The working tree matches the last commit.")) { store, cwd in
                    let tree: String? = try await store.call(key.server, "head_tree", ["cwd": .string(cwd)])
                    guard let tree else { return nil }
                    return try await store.call(key.server, "changes_since",
                                                ["cwd": .string(cwd), "baseline": .string(tree), "head": nil])
                }
            case .branch:
                ChangeList(key: key, reload: "branch|\(busy)",
                           nothing: ("No commits on this branch", "Committed work since the branch forked shows here."),
                           clean: ("No changes", "This branch's commits add up to no change.")) { store, cwd in
                    let commits = try await branchCommits(store, cwd)
                    guard let newest = commits.first, let oldest = commits.last else { return nil }
                    return try await store.call(key.server, "changes_since",
                                                ["cwd": .string(cwd), "baseline": .string(oldest.base), "head": .string(newest.sha)])
                }
            case .commits:
                CommitList(key: key, reload: "\(busy)")
            }
        }
        .page()
        .navigationTitle("Changes")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Every commit the branch made since it forked, newest first.
    private func branchCommits(_ store: Store, _ cwd: String) async throws -> [Commit] {
        var all: [Commit] = []
        while true {
            let page: [Commit] = try await store.call(key.server, "log_branch_commits",
                                                      ["cwd": .string(cwd), "limit": 200, "skip": JSON(all.count)])
            all += page
            if page.count < 200 { return all }
        }
    }
}

/// A change set's files, each opening its diff. `read` answers nil where there
/// is nothing to compare, which draws `nothing`; an empty set draws `clean`.
private struct ChangeList: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    /// Changes when the answer may have: a turn ending, the reader switching tabs.
    let reload: String
    let nothing: (title: String, message: String)
    let clean: (title: String, message: String)
    var note: String? = nil
    let read: (Store, String) async throws -> ChangeSet?

    @State private var changes: ChangeSet?
    @State private var none = false
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        Group {
            if let error, changes == nil {
                EmptyState(title: "Couldn't read changes", message: sentence(error)) {
                    Image(systemName: "exclamationmark.triangle").font(.system(size: 32)).foregroundStyle(Theme.tertiary)
                } actions: {
                    Button("Try again") { Task { await load() } }.buttonStyle(PillButtonStyle())
                }
            } else if !loaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if none || changes == nil {
                empty(nothing)
            } else if let changes, changes.files.isEmpty, note == nil {
                empty(clean)
            } else if let changes {
                files(changes)
            }
        }
        .task(id: reload) { await load() }
    }

    private func load() async {
        guard let cwd = store.items[key]?.cwd else { return }
        do {
            let next = try await read(store, cwd)
            (changes, none, error) = (next, next == nil, nil)
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func empty(_ text: (title: String, message: String)) -> some View {
        ScrollView {
            EmptyState(title: text.title, message: text.message) {
                Image(systemName: "plus.forwardslash.minus").font(.system(size: 32)).foregroundStyle(Theme.tertiary)
            }
            .containerRelativeFrame(.vertical)
        }
        .refreshable { await load() }
    }

    /// One group per folder, the folder's glyph and path over its files: root files first, then folders by path.
    private func files(_ set: ChangeSet) -> some View {
        var byDir: [String: [ChangedFile]] = [:]
        for f in set.files { byDir[splitPath(f.path).dir, default: []].append(f) }
        let dirs = byDir.keys.sorted { $0.isEmpty != $1.isEmpty ? $0.isEmpty : $0 < $1 }
        return List {
            ForEach(Array(dirs.enumerated()), id: \.element) { i, dir in
                Section {
                    ForEach(byDir[dir] ?? [], id: \.self) { file in
                        NavigationLink {
                            DiffScreen(key: key, base: set.base, head: set.head, file: file)
                        } label: {
                            FileRow(file: file)
                        }
                        .listRowBackground(Theme.card)
                    }
                } header: {
                    VStack(alignment: .leading, spacing: Theme.Space.m) {
                        if i == 0 { summary(set) }
                        if !dir.isEmpty {
                            HStack(spacing: Theme.Space.s) {
                                FileIcon(path: dir, folder: true)
                                Text(dir).lineLimit(1).truncationMode(.head)
                            }
                            .font(Theme.Font.footnote)
                            .foregroundStyle(Theme.secondary)
                        }
                    }
                    .textCase(nil)
                }
            }
        }
        .listStyle(.insetGrouped)
        .themedList()
        .refreshable { await load() }
    }

    private func summary(_ set: ChangeSet) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            if let note {
                Text(note).font(Theme.Font.subhead).foregroundStyle(Theme.text)
            }
            HStack(spacing: 6) {
                Text("\(set.files.count) \(set.files.count == 1 ? "file" : "files")").foregroundStyle(Theme.secondary)
                Counts(added: set.added, removed: set.removed)
            }
            .font(Theme.Font.footnote)
        }
    }
}

private struct Counts: View {
    let added: Int
    let removed: Int

    var body: some View {
        HStack(spacing: 6) {
            Text("+\(added)").foregroundStyle(Theme.add)
            Text("−\(removed)").foregroundStyle(Theme.destructive)
        }
        .monospacedDigit()
    }
}

/// A file's type glyph and name, its counts at the end. Its folder is the group's header.
private struct FileRow: View {
    let file: ChangedFile

    var body: some View {
        HStack(spacing: Theme.Space.m) {
            FileIcon(path: file.path)
            VStack(alignment: .leading, spacing: 2) {
                Text(splitPath(file.path).name)
                    .font(Theme.Font.body)
                    .foregroundStyle(file.status == "deleted" ? Theme.secondary : Theme.text)
                    .strikethrough(file.status == "deleted")
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let old = file.oldPath {
                    Text("from \(old)").font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                        .lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: 0)
            Group {
                if file.binary {
                    Text("binary").foregroundStyle(Theme.tertiary)
                } else if file.status == "added" && file.removed == 0 {
                    HStack(spacing: 6) { Text("new").foregroundStyle(Theme.tertiary); Counts(added: file.added, removed: 0) }
                } else {
                    Counts(added: file.added, removed: file.removed)
                }
            }
            .font(Theme.Font.footnote)
        }
        .padding(.vertical, 2)
    }
}

/// The desktop's `FileIcon`: the Material glyph for a file's type or a folder's
/// name, full colour, from the set `scripts/file_icons.py` copies in.
struct FileIcon: View {
    let path: String
    var folder = false

    var body: some View {
        Image(FileIcons.name(path, folder: folder)).resizable().scaledToFit().frame(width: 16, height: 16)
            .accessibilityHidden(true)
    }
}

/// `vscode-material-icons`' lookup, over its map as `file-icons.json` holds it.
enum FileIcons {
    private struct Map: Decodable {
        let fileNames: [String: String]
        let fileExtensions: [String: String]
        let folderNames: [String: String]
    }

    private static let map: Map? = Bundle.main.url(forResource: "file-icons", withExtension: "json")
        .flatMap { try? JSONDecoder().decode(Map.self, from: Data(contentsOf: $0)) }

    /// The asset's name. Matched as the package matches: whole name, then
    /// lowercased, then everything after the first dot, then after the last,
    /// then the three it names by hand, since the map leaves them to VS Code's language ids.
    static func name(_ path: String, folder: Bool = false) -> String {
        let base = path.split(separator: "/").last.map(String.init) ?? path
        guard let map else { return folder ? "fi-folder" : "fi-file" }
        if folder { return "fi-" + (map.folderNames[base] ?? map.folderNames[base.lowercased()] ?? "folder") }
        let suffix = base.firstIndex(of: ".").map { String(base[base.index(after: $0)...]) } ?? base
        let ext = base.lastIndex(of: ".").map { String(base[base.index(after: $0)...]) } ?? base
        let byHand = base.hasSuffix(".html") ? "html" : base.hasSuffix(".ts") ? "typescript"
            : base.hasSuffix(".js") ? "javascript" : nil
        return "fi-" + (map.fileNames[base] ?? map.fileNames[base.lowercased()] ?? map.fileExtensions[suffix]
            ?? map.fileExtensions[ext] ?? byHand ?? "file")
    }
}

private func splitPath(_ path: String) -> (dir: String, name: String) {
    guard let cut = path.lastIndex(of: "/") else { return ("", path) }
    return (String(path[..<cut]), String(path[path.index(after: cut)...]))
}

/// The history, a page at a time; a commit opens its own changes.
private struct CommitList: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let reload: String

    @State private var commits: [Commit] = []
    @State private var more = false
    @State private var error: String?
    @State private var loaded = false
    @State private var paging = false
    private let page = 50

    var body: some View {
        Group {
            if let error, commits.isEmpty {
                EmptyState(title: "Couldn't read history", message: sentence(error)) {
                    Image(systemName: "exclamationmark.triangle").font(.system(size: 32)).foregroundStyle(Theme.tertiary)
                } actions: {
                    Button("Try again") { Task { await load(reset: true) } }.buttonStyle(PillButtonStyle())
                }
            } else if !loaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if commits.isEmpty {
                EmptyState(title: "No commits yet", message: "This branch has nothing committed.") {
                    Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 32)).foregroundStyle(Theme.tertiary)
                }
            } else {
                List {
                    ForEach(commits) { commit in
                        NavigationLink {
                            CommitScreen(key: key, commit: commit)
                        } label: {
                            CommitRow(commit: commit)
                        }
                        .listRowBackground(Theme.card)
                    }
                    if more {
                        HStack {
                            Spacer()
                            if paging { ProgressView() } else { Button("Load more") { Task { await load(reset: false) } } }
                            Spacer()
                        }
                        .listRowBackground(Theme.card)
                    }
                }
                .listStyle(.insetGrouped)
                .themedList()
                .refreshable { await load(reset: true) }
            }
        }
        .task(id: reload) { await load(reset: true) }
    }

    private func load(reset: Bool) async {
        guard let cwd = store.items[key]?.cwd, !paging else { return }
        paging = true
        defer { paging = false }
        do {
            let next: [Commit] = try await store.call(key.server, "log_commits",
                                                      ["cwd": .string(cwd), "limit": JSON(page), "skip": JSON(reset ? 0 : commits.count)])
            // A refresh keeps the pages read below an unchanged tip, as `reconcileLog` does.
            if reset {
                if commits.first?.sha != next.first?.sha { (commits, more) = (next, next.count == page) }
            } else {
                commits += next
                more = next.count == page
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }
}

private struct CommitRow: View {
    let commit: Commit

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(commit.subject).font(Theme.Font.body).foregroundStyle(Theme.text).lineLimit(2)
            HStack(spacing: 4) {
                Text(commit.author).lineLimit(1)
                if let at = parseDate(commit.authoredAt) { Text("· \(shortAge(at))") }
                Text("· \(commit.sha.prefix(7))").monospaced()
            }
            .font(Theme.Font.footnote)
            .foregroundStyle(Theme.tertiary)
        }
        .padding(.vertical, 2)
    }
}

/// One commit's own changes, its message on top.
private struct CommitScreen: View {
    let key: SessionKey
    let commit: Commit

    var body: some View {
        let message = commit.body.isEmpty ? commit.subject : "\(commit.subject)\n\n\(commit.body)"
        ChangeList(key: key, reload: commit.sha,
                   nothing: ("Nothing to compare", ""),
                   clean: ("No file changes", "This commit changed no files."),
                   note: message) { store, cwd in
            try await store.call(key.server, "changes_since",
                                 ["cwd": .string(cwd), "baseline": .string(commit.base), "head": .string(commit.sha)])
        }
        .page()
        .navigationTitle(String(commit.sha.prefix(7)))
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// One file's change as a unified diff: lines wrap rather than scroll sideways.
private struct DiffScreen: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let base: String
    let head: String
    let file: ChangedFile

    @State private var rows: [DiffRow]?
    @State private var withheld: String?
    @State private var error: String?

    var body: some View {
        Group {
            if file.binary {
                message("Binary file", "There are no lines to compare.")
            } else if let withheld {
                message(withheld == "binary" ? "Binary file" : "Too large to show", withheld == "binary"
                        ? "There are no lines to compare." : "One side is over 1 MB.")
            } else if let error {
                message("Couldn't read this file", sentence(error))
            } else if let rows, rows.isEmpty {
                message("No line changes", "Only the file's mode or name changed.")
            } else if let rows {
                lines(rows)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .page()
        .navigationTitle(splitPath(file.path).name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Counts(added: file.added, removed: file.removed).font(Theme.Font.footnote) }
        }
        .task { await load() }
    }

    private func load() async {
        guard !file.binary, let cwd = store.items[key]?.cwd else { return }
        do {
            let v: FileVersions = try await store.call(key.server, "file_change", [
                "cwd": .string(cwd), "base": .string(base), "head": .string(head),
                "path": .string(file.path), "oldPath": JSON(file.oldPath),
            ])
            if let u = v.unreadable { withheld = u; return }
            // Off the main thread: a long file's difference takes a moment.
            rows = await Task.detached { unifiedDiff(old: v.oldText, new: v.newText) }.value
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func message(_ title: String, _ text: String) -> some View {
        EmptyState(title: title, message: text) {
            Image(systemName: "doc.text").font(.system(size: 32)).foregroundStyle(Theme.tertiary)
        }
    }

    private func lines(_ rows: [DiffRow]) -> some View {
        let digits = String(rows.reduce(0) { if case .line(_, let n, _) = $1 { max($0, n) } else { $0 } }).count
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Theme.Space.s) {
                    FileIcon(path: file.path)
                    Text(file.oldPath.map { "\($0) → \(file.path)" } ?? file.path)
                        .font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                }
                .padding(.horizontal, Theme.Space.l).padding(.bottom, Theme.Space.m)
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(rows.indices, id: \.self) { DiffLine(row: rows[$0], digits: digits) }
                }
                .padding(.vertical, Theme.Space.xs)
                .well()
                .clipShape(.rect(cornerRadius: Theme.Radius.md, style: .continuous))
                .padding(.horizontal, Theme.Space.s)
            }
            .padding(.vertical, Theme.Space.m)
        }
    }
}

private struct DiffLine: View {
    let row: DiffRow
    let digits: Int

    var body: some View {
        switch row {
        case .gap(let n):
            Text("⋯ \(n) unchanged \(n == 1 ? "line" : "lines")")
                .font(Theme.Font.footnote)
                .foregroundStyle(Theme.tertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Theme.Space.m)
                .padding(.vertical, 6)
                .background(Theme.card)
        case .line(let sign, let number, let text):
            let tint = sign == "+" ? Theme.add : sign == "-" ? Theme.destructive : Color.clear
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                // A template of the widest number holds the gutter steady at any text size.
                ZStack(alignment: .trailing) {
                    Text(String(repeating: "0", count: digits)).hidden()
                    Text(String(number))
                }
                .foregroundStyle(Theme.tertiary)
                Text(String(sign)).foregroundStyle(sign == " " ? Theme.tertiary : tint)
                Text(text.isEmpty ? " " : text)
                    .foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(Theme.Font.code)
            .padding(.horizontal, Theme.Space.s)
            .padding(.vertical, 1)
            .background(tint.opacity(0.14))
        }
    }
}
