import Foundation

/// `github.rs`'s `PullRequest`. Words GitHub chooses — state, check state,
/// comment kind — stay strings, so a new one reads as unknown rather than
/// failing the list.
struct PullRequest: Decodable, Identifiable {
    let number: Int
    let title: String
    let url: String
    let state: String
    let isDraft: Bool
    let author: String
    let baseRefName: String
    let mergeable: String
    let mergeStateStatus: String
    let reviewDecision: String?
    let checks: [PrCheck]
    let comments: [PrComment]
    let additions: Int
    let deletions: Int
    let changedFiles: Int

    var id: Int { number }
    var verdict: MergeVerdict {
        mergeVerdict(state: state, isDraft: isDraft, mergeable: mergeable, mergeStateStatus: mergeStateStatus)
    }
    /// Something GitHub is still working out, which sets how often an open sheet re-reads.
    var settling: Bool {
        state == "OPEN" && (mergeable == "UNKNOWN" || checks.contains { $0.state == "pending" })
    }
}

struct PrCheck: Decodable, Hashable {
    let name: String
    let state: String
    let url: String?
}

struct PrComment: Decodable, Hashable {
    let author: String
    let avatar: String?
    let body: String
    let url: String
    let kind: String
    let path: String?
    let resolved: Bool
    let replies: [PrComment]
}

/// Why the server could not ask GitHub: `{"kind":…,"detail":…}`.
struct PrUnavailable: Decodable, Equatable {
    let kind: String
    let detail: String?

    /// The two the reader can install or log their way out of, which keep the button.
    var keepsButton: Bool { kind == "no_cli" || kind == "not_authenticated" }

    /// The desktop panel's words; `other` carries `gh`'s own sentence.
    var sentence: String {
        switch kind {
        case "no_cli": "GitHub CLI (gh) is not installed on this server. Run `dray setup` there to install it."
        case "not_authenticated": "GitHub CLI is not logged in on this server. Run `gh auth login` there to see pull requests here."
        case "no_remote": "This directory has no GitHub remote."
        default: detail ?? kind
        }
    }
}

/// The branch a session's work lands on; `sessionBranch` in `pr.ts`, whose
/// comment carries the why. HEAD wins while the session has a checkout of its
/// own, a relocated session's shared checkout never answers, and the rest is
/// the guess made at creation.
func sessionBranch(branch: String?, worktreeName: String?, worktreeRemoved: Bool, observed: String?) -> String? {
    if worktreeRemoved { return branch }
    if let observed, !observed.isEmpty { return observed }
    return worktreeName.map { "worktree-\($0)" } ?? branch
}

enum MergeVerdict: Equatable {
    case merged, closed, conflict, unknown, draft, behind, blocked, unstable, ready
}

/// Why a pull request can or cannot land; `mergeVerdict` in `pr.ts`. The order
/// is the whole logic: a closed PR's merge state is stale, a conflict outranks
/// everything open, a draft is stored where the statuses below it are what
/// GitHub recomputes while it says `UNKNOWN`.
func mergeVerdict(state: String, isDraft: Bool, mergeable: String, mergeStateStatus: String) -> MergeVerdict {
    if state == "MERGED" { return .merged }
    if state == "CLOSED" { return .closed }
    if mergeable == "CONFLICTING" || mergeStateStatus == "DIRTY" { return .conflict }
    if isDraft { return .draft }
    if mergeable == "UNKNOWN" { return .unknown }
    switch mergeStateStatus {
    case "BEHIND": return .behind
    case "BLOCKED": return .blocked
    case "UNSTABLE": return .unstable
    case "UNKNOWN": return .unknown
    // `CLEAN` and `HAS_HOOKS`.
    default: return .ready
    }
}

/// The verdict in the reader's words: a label, and a line of why where one helps.
func readiness(_ pr: PullRequest) -> (label: String, detail: String?) {
    switch pr.verdict {
    case .merged: ("Merged", nil)
    case .closed: ("Closed without merging", nil)
    case .conflict: ("Conflicts with base", "Resolve against \(pr.baseRefName) before merging.")
    case .unknown: ("Checking mergeability…", nil)
    case .draft: ("Draft", "Mark ready to request review and merge.")
    case .behind: ("Behind \(pr.baseRefName)", "Update the branch before merging.")
    case .blocked: ("Blocked", pr.reviewDecision == "CHANGES_REQUESTED" ? "Changes were requested."
        : pr.reviewDecision == "REVIEW_REQUIRED" ? "A review is required."
        : "A required check or rule is not satisfied.")
    case .unstable: ("Checks not passing", "Merging is allowed, but something is red.")
    case .ready: ("Ready to merge", nil)
    }
}

/// A comment body as plain-ish text for markdown: bots hide state in `[vc]: #…`
/// lines and HTML comments, and write HTML as often as markdown.
func commentText(_ body: String) -> String {
    // Code keeps its text whole: `Array<T>` in backticks is no tag.
    let code = try! NSRegularExpression(pattern: "```[\\s\\S]*?(```|$)|`[^`\\n]*`")
    let ns = body as NSString
    var out = "", last = 0
    for m in code.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
        out += prose(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
        out += ns.substring(with: m.range)
        last = m.range.location + m.range.length
    }
    return (out + prose(ns.substring(from: last))).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func prose(_ text: String) -> String {
    var s = text
    for pattern in [#"(?im)^\[[a-z-]+\]: #[^\n]*\n?"#, #"<!--[\s\S]*?-->"#, #"<[a-zA-Z/!][^>]*>"#] {
        s = s.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
    }
    // `&amp;` last, or `&amp;lt;` would decode twice.
    for (entity, char) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&nbsp;", " "), ("&amp;", "&")] {
        s = s.replacingOccurrences(of: entity, with: char)
    }
    return s
}
