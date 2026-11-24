import Foundation

/// A project is named by its server and its path, the way a session is.
struct ProjectKey: Hashable, Codable {
    let server: UUID
    let path: String
}

typealias Entry = (key: SessionKey, item: SessionItem)

struct ListRow: Identifiable {
    let key: SessionKey
    let item: SessionItem
    let depth: Int
    var id: SessionKey { key }
}

/// What a run of rows is waiting on, strongest first, which is also the order
/// the runs are drawn in — the desktop's `SESSION_STATES`. Mid-turn is not a
/// stage: the row's orb says it, and a run of its own moved a row twice.
/// Pinned is no stage anything reaches by state: the reader's own picks, led out first.
enum Stage: Int, CaseIterable, Comparable {
    case pinned, asking, completed, idle, unreadPr, pr, checks, merged, aside
    static func < (a: Stage, b: Stage) -> Bool { a.rawValue < b.rawValue }
}

/// The desktop sidebar's live list (`sessionGroups` in Sidebar.tsx): one run
/// per stage, workspace-wide, drawn under no heading but Pinned's. A nest stays whole under
/// its root and takes the strongest stage anything in it holds. `pins` off for
/// the settled list, a history where a pin says nothing.
func stageRuns(_ list: [Entry], now: Date = .now, pins: Bool = true, stage: (Entry) -> Stage) -> [(stage: Stage, rows: [ListRow])] {
    let split = splitPinned(pins ? list : [])
    let pinned = split.pinned, unpinned = pins ? split.rest : list
    let (aside, active) = splitAside(unpinned, now: now)
    var runs: [Stage: [ListRow]] = [:]
    let pinnedRows = nests(pinned).flatMap { $0 }
    if !pinnedRows.isEmpty { runs[.pinned] = pinnedRows }
    let held = nests(active)
    let flat = held.flatMap { $0 }
    func strongest(_ rows: [ListRow]) -> Stage { rows.map { stage(($0.key, $0.item)) }.min()! }
    // A short list is one run: there is nothing to scan in two rows.
    if flat.count < 3 {
        if !flat.isEmpty { runs[strongest(flat)] = flat }
    } else {
        for nest in held { runs[strongest(nest), default: []] += nest }
        // A run of one row between two breaks reads as a heading, so
        // neighbouring single-row stages in one family share a break.
        for family: [Stage] in [[.asking, .completed], [.unreadPr, .pr, .checks, .merged]] {
            var into: Stage?
            for s in family {
                guard let rows = runs[s] else { continue }
                if rows.count > 1 { into = nil }
                else if let i = into { runs[i]! += rows; runs[s] = nil }
                else { into = s }
            }
        }
    }
    let rest = nests(aside).flatMap { $0 }
    if !rest.isEmpty { runs[.aside, default: []] += rest }
    return Stage.allCases.compactMap { s in runs[s].map { (s, $0) } }
}

/// Rows in draw order, a spawned session under its parent, newest first at
/// every level, cut into nests at each root. A child whose parent is not
/// listed draws as a root; a cycle costs an odd order, never a lost row.
private func nests(_ list: [Entry]) -> [[ListRow]] {
    let present = Set(list.map(\.key))
    let parent = { (e: Entry) -> SessionKey? in
        e.item.parentSessionId.map { SessionKey(server: e.key.server, id: $0) }.flatMap { present.contains($0) ? $0 : nil }
    }
    var kids: [SessionKey: [Entry]] = [:]
    for e in list { if let p = parent(e) { kids[p, default: []].append(e) } }
    let newest = { (a: Entry, b: Entry) in a.item.modified > b.item.modified }

    var out: [[ListRow]] = []
    var seen = Set<SessionKey>()
    func walk(_ e: Entry, _ depth: Int) {
        guard seen.insert(e.key).inserted else { return }
        out[out.count - 1].append(ListRow(key: e.key, item: e.item, depth: depth))
        for k in (kids[e.key] ?? []).sorted(by: newest) { walk(k, depth + 1) }
    }
    for e in list.filter({ parent($0) == nil }).sorted(by: newest) + list.sorted(by: newest) where !seen.contains(e.key) {
        out.append([])
        walk(e, 0)
    }
    return out
}

/// Pinned, or under a pinned ancestor and not set aside itself — the desktop's
/// `splitPinned`. A nest follows its pin whole, so neither half splits one.
private func splitPinned(_ list: [Entry]) -> (pinned: [Entry], rest: [Entry]) {
    let byKey = Dictionary(list.map { ($0.key, $0.item) }, uniquingKeysWith: { a, _ in a })
    func underPin(_ e: Entry) -> Bool {
        if e.item.aside == true { return false }
        // Guarded, so a cycle in the index costs an odd grouping, never a hang.
        var seen = Set<SessionKey>()
        var at: Entry? = e
        while let cur = at, seen.insert(cur.key).inserted {
            if cur.item.pinned == true { return true }
            at = cur.item.parentSessionId.flatMap { id in
                let k = SessionKey(server: cur.key.server, id: id)
                return byKey[k].map { (k, $0) }
            }
        }
        return false
    }
    var pinned: [Entry] = [], rest: [Entry] = []
    for e in list { if underPin(e) { pinned.append(e) } else { rest.append(e) } }
    return (pinned, rest)
}

/// Set aside by the reader, or untouched three days with nothing below still
/// moving — the desktop's `splitAside`.
private func splitAside(_ list: [Entry], now: Date) -> (aside: [Entry], rest: [Entry]) {
    var kids: [SessionKey: [Entry]] = [:]
    for e in list {
        if let p = e.item.parentSessionId { kids[SessionKey(server: e.key.server, id: p), default: []].append(e) }
    }
    let stale = { (e: Entry) in now.timeIntervalSince(parseDate(e.item.modified) ?? now) > 3 * 24 * 3600 }
    // Seeded false before the children are asked, so a cycle answers.
    var memo: [SessionKey: Bool] = [:]
    func moving(_ e: Entry) -> Bool {
        if let known = memo[e.key] { return known }
        memo[e.key] = false
        let v = (e.item.aside != true && !stale(e)) || (kids[e.key] ?? []).contains(where: moving)
        memo[e.key] = v
        return v
    }
    var aside: [Entry] = [], rest: [Entry] = []
    for e in list {
        if e.item.aside != true && moving(e) { rest.append(e) } else { aside.append(e) }
    }
    return (aside, rest)
}

/// One branch's mark out of every PR on it: open beats draft beats merged,
/// ties to the first — `pickPrMark` in pr.ts.
func pickMark(_ prs: [PrMark]) -> PrMark? {
    let rank = { (p: PrMark) in p.state != "OPEN" ? 2 : p.isDraft ? 1 : 0 }
    return prs.reduce(nil) { best, p in best.map { rank(p) < rank($0) ? p : $0 } ?? p }
}
