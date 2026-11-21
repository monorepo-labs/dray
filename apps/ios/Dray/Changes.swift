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

// MARK: Unified diff

enum DiffRow: Hashable {
    /// `number` is the new side's line, or the old side's on a removal.
    case line(sign: Character, number: Int, text: String)
    /// Unchanged lines folded out between hunks.
    case gap(Int)
    /// The line above ends its file with no newline, git's `\ No newline at end of file`.
    case noNewline
}

/// Carried on a file's last line when no newline follows it, so adding or
/// dropping that newline differs like any other edit. Never shown.
private let noEOL: Character = "\u{1}"

/// A unified diff with `context` lines around each change, from the
/// standard library's own Myers difference.
func unifiedDiff(old: String?, new: String?, context: Int = 3) -> [DiffRow] {
    func lines(_ s: String?) -> [String] {
        guard let s, !s.isEmpty else { return [] }
        // By scalar: Swift reads "\r\n" as one Character, so a CRLF file never split on "\n".
        let scalars = s.unicodeScalars
        var all = scalars.split(separator: "\n", omittingEmptySubsequences: false).map { String(String.UnicodeScalarView($0)) }
        if scalars.last == "\n" { all.removeLast() } else { all[all.count - 1].append(noEOL) }
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
    func add(_ sign: Character, _ number: Int, _ text: String) {
        all.append(.line(sign: sign, number: number, text: text.last == noEOL ? String(text.dropLast()) : text))
        if text.last == noEOL { all.append(.noNewline) }
    }
    var i = 0, j = 0
    while i < a.count || j < b.count {
        if i < a.count, removed.contains(i) {
            add("-", i + 1, a[i]); i += 1
        } else if j < b.count, inserted.contains(j) {
            add("+", j + 1, b[j]); j += 1
        } else {
            add(" ", j + 1, b[j]); i += 1; j += 1
        }
    }
    var keep = [Bool](repeating: false, count: all.count)
    for (k, row) in all.enumerated() {
        guard case .line(let sign, _, _) = row, sign != " " else { continue }
        for n in max(0, k - context)...min(all.count - 1, k + context) { keep[n] = true }
    }
    // The note goes wherever its line goes.
    for (k, row) in all.enumerated() where row == .noNewline && k > 0 { keep[k] = keep[k - 1] }
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

private enum ChangesTab: String {
    case uncommitted = "Uncommitted", branch = "Branch", commits = "Commits"
}

/// What the agent changed, three ways: the uncommitted tree, while there is
/// one, the whole branch since it forked, and the history a commit at a time.
/// Reads only, as the desktop's repo view does.
struct ChangesScreen: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    @State private var tab = ChangesTab.branch
    @State private var dirty = false
    /// `work_status` has been asked once. Until then no list reads, so the screen
    /// never draws Branch's files only to jump to Uncommitted.
    @State private var known = false

    var body: some View {
        let busy = store.items[key]?.busy ?? false
        let connected = store.serverState[key.server] == .connected
        VStack(spacing: 0) {
            Picker("Show", selection: $tab) {
                ForEach((dirty ? [.uncommitted] : []) + [ChangesTab.branch, .commits], id: \.self) { Text($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Theme.Space.l)
            .padding(.vertical, Theme.Space.s)
            if known { list(tab, busy: busy) } else { Spacer() }
        }
        .page()
        .navigationTitle("Changes")
        .navigationBarTitleDisplayMode(.inline)
        // Re-asked as each turn starts and ends, since a turn is what dirties or commits the
        // tree, and on reconnect, since a read that failed with the socket down said nothing.
        .task(id: "\(busy)|\(connected)") { await readDirty() }
    }

    /// Whether the tree holds uncommitted work: Uncommitted shows, and leads, only then.
    /// A failed read changes nothing, so a dropped socket never hides edits.
    private func readDirty() async {
        guard let cwd = store.items[key]?.cwd else { return }
        if let status: WorkStatus = try? await store.call(key.server, "work_status", ["cwd": .string(cwd)]) {
            dirty = (status.dirty ?? 0) > 0
            if !known, dirty { tab = .uncommitted } else if tab == .uncommitted, !dirty { tab = .branch }
        }
        known = true
    }

    @ViewBuilder private func list(_ tab: ChangesTab, busy: Bool) -> some View {
        switch tab {
        case .uncommitted:
            ChangeList(key: key, reload: "work|\(busy)", refreshed: readDirty,
                       nothing: ("Not a repository", "This folder isn't tracked by git."),
                       clean: ("Nothing uncommitted", "The working tree matches the last commit.")) { store, cwd in
                let tree: String? = try await store.call(key.server, "head_tree", ["cwd": .string(cwd)])
                guard let tree else { return nil }
                return try await store.call(key.server, "changes_since",
                                            ["cwd": .string(cwd), "baseline": .string(tree), "head": nil])
            }
        case .branch:
            ChangeList(key: key, reload: "branch|\(busy)", refreshed: readDirty,
                       nothing: ("No commits on this branch", "Committed work since the branch forked shows here."),
                       clean: ("No changes", "This branch's commits add up to no change.")) { store, cwd in
                let commits = try await branchCommits(store, cwd)
                guard let newest = commits.first, let oldest = commits.last else { return nil }
                return try await store.call(key.server, "changes_since",
                                            ["cwd": .string(cwd), "baseline": .string(oldest.base), "head": .string(newest.sha)])
            }
        case .commits:
            CommitList(key: key, reload: "\(busy)", refreshed: readDirty)
        }
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
    /// Run beside a pull-to-refresh: the screen's own status check.
    var refreshed: () async -> Void = {}
    let nothing: (title: String, message: String)
    let clean: (title: String, message: String)
    var note: String? = nil
    let read: (Store, String) async throws -> ChangeSet?

    @State private var changes: ChangeSet?
    @State private var none = false
    @State private var error: String?
    @State private var loaded = false
    /// Only the newest read may land: a cancelled task's call still answers, and a
    /// mid-turn read finishing after the turn's last one would put stale files back.
    @State private var generation = 0

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
        generation += 1
        let mine = generation
        do {
            let next = try await read(store, cwd)
            guard mine == generation else { return }
            (changes, none, error) = (next, next == nil, nil)
        } catch {
            guard mine == generation else { return }
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func refresh() async {
        await refreshed()
        await load()
    }

    private func empty(_ text: (title: String, message: String)) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                if let error { RefreshFailed(error: error) { await refresh() }.padding(Theme.Space.l) }
                EmptyState(title: text.title, message: text.message) {
                    Image(systemName: "plus.forwardslash.minus").font(.system(size: 32)).foregroundStyle(Theme.tertiary)
                }
            }
            .containerRelativeFrame(.vertical)
        }
        .refreshable { await refresh() }
    }

    /// One group per folder, the folder's glyph and path over its files: root files first, then folders by path.
    private func files(_ set: ChangeSet) -> some View {
        var byDir: [String: [ChangedFile]] = [:]
        for f in set.files { byDir[splitPath(f.path).dir, default: []].append(f) }
        let dirs = byDir.keys.sorted { $0.isEmpty != $1.isEmpty ? $0.isEmpty : $0 < $1 }
        return List {
            if let error {
                RefreshFailed(error: error) { await refresh() }.listRowBackground(Color.clear)
            }
            // A commit that changed no files still says what it was.
            if dirs.isEmpty {
                Section {
                    Text("No file changes").font(Theme.Font.body).foregroundStyle(Theme.tertiary).listRowBackground(Theme.card)
                } header: {
                    summary(set).textCase(nil)
                }
            }
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
        .refreshable { await refresh() }
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

/// A refresh that failed over rows already shown: they stay, and this says they may be old.
private struct RefreshFailed: View {
    let error: String
    let retry: () async -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
            Text("Couldn't refresh: \(sentence(error))")
                .font(Theme.Font.footnote)
                .foregroundStyle(Theme.destructive)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Try again") { Task { await retry() } }
                .font(Theme.Font.footnoteStrong)
                .foregroundStyle(Theme.text)
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
    var refreshed: () async -> Void = {}

    @State private var commits: [Commit] = []
    @State private var more = false
    @State private var error: String?
    @State private var loaded = false
    @State private var paging = false
    /// A refresh asked for while a read was out, run once it lands.
    @State private var resetQueued = false
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
                    if let error {
                        RefreshFailed(error: error) { await load(reset: true) }.listRowBackground(Color.clear)
                    }
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
                .refreshable {
                    await refreshed()
                    await load(reset: true)
                }
            }
        }
        .task(id: reload) { await load(reset: true) }
    }

    private func load(reset: Bool) async {
        guard let cwd = store.items[key]?.cwd else { return }
        // One read at a time. A refresh arriving meanwhile waits its turn rather than
        // being dropped: a commit landing during Load more would otherwise never show.
        if paging {
            if reset { resetQueued = true }
            return
        }
        paging = true
        do {
            let next: [Commit] = try await store.call(key.server, "log_commits",
                                                      ["cwd": .string(cwd), "limit": JSON(page), "skip": JSON(reset ? 0 : commits.count)])
            // A page read against the old tip may overlap the new one; the queued refresh replaces it.
            if !resetQueued {
                // A refresh keeps the pages read below an unchanged tip, as `reconcileLog` does.
                if reset {
                    if commits.first?.sha != next.first?.sha { (commits, more) = (next, next.count == page) }
                } else {
                    commits += next
                    more = next.count == page
                }
                error = nil
            }
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
        paging = false
        if resetQueued {
            resetQueued = false
            await load(reset: true)
        }
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
    /// Each side's lines coloured whole, so a span crossing lines — a block comment — reads right.
    @State private var colored: (old: [AttributedString]?, new: [AttributedString]?)
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
            if let old = v.oldText {
                colored.old = await Highlighter.shared.lines(old, lang: highlightLanguage(file.oldPath ?? file.path))
            }
            if let new = v.newText {
                colored.new = await Highlighter.shared.lines(new, lang: highlightLanguage(file.path))
            }
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
                    ForEach(rows.indices, id: \.self) { DiffLine(row: rows[$0], digits: digits, colored: coloredLine(rows[$0])) }
                }
                .padding(.vertical, Theme.Space.xs)
                .well()
                .clipShape(.rect(cornerRadius: Theme.Radius.md, style: .continuous))
                .padding(.horizontal, Theme.Space.s)
            }
            .padding(.vertical, Theme.Space.m)
        }
    }

    /// A removal's number counts the old side's lines, every other row's the new side's.
    private func coloredLine(_ row: DiffRow) -> AttributedString? {
        guard case .line(let sign, let number, let text) = row,
              let side = sign == "-" ? colored.old : colored.new, number <= side.count else { return nil }
        // A coloured line that drifted from the diff's own would hide an edit; plain text never does.
        let line = side[number - 1]
        return String(line.characters) == drawn(text) ? line : nil
    }
}

/// A row's text as drawn: a CRLF line keeps its CR to diff against LF, but drawn it breaks the line.
private func drawn(_ text: String) -> String {
    text.unicodeScalars.last == "\r" ? String(text.dropLast()) : text
}

private struct DiffLine: View {
    let row: DiffRow
    let digits: Int
    var colored: AttributedString?

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
        case .noNewline:
            Text("No newline at end of file")
                .font(Theme.Font.footnote)
                .foregroundStyle(Theme.tertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Theme.Space.m)
                .padding(.vertical, 2)
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
                let shown = drawn(text)
                Text(shown.isEmpty ? AttributedString(" ") : colored ?? AttributedString(shown))
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
