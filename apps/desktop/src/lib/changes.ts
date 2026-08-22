import type { AgentEvent } from "@/types/events";

export type ChangeRange = {
  /// The newest prompt's snapshot — the "before" side. Null when there is
  /// nothing to diff against, which is ordinary rather than an error: a
  /// session in a plain directory records no snapshots, and neither does one
  /// whose prompts predate the field.
  baseline: string | null;
  /// The snapshot the turn's own `turn_completed` carried — the "after" side,
  /// frozen when the turn finished. Null while the turn is still running (or
  /// for one that never closed), which the panel reads as "diff against the
  /// working tree as it stands now".
  head: string | null;
};

/// The two trees the panel diffs: the newest prompt's baseline, and the frozen
/// head of the newest turn that completed *after* it.
///
/// Freezing the head is what scopes an idle session to its own last turn. The
/// baseline alone bounds only the start of the range — with the end left at
/// "now", a session read an hour later attributes everything that touched the
/// checkout since (another session's turns, the user's editor) to a turn that
/// finished long ago. A running turn genuinely has no end yet, so only there
/// does the range stay open.
///
/// A prompt whose own baseline is null is skipped rather than ending the
/// search. That matters for a worktree session, whose first prompt can fail to
/// snapshot — falling through to the neighbouring prompt shows a range slightly
/// off from the one asked for, which beats showing nothing.
///
/// Deliberately only the last turn. A session-wide baseline is the same code
/// reading a different prompt, but it would be *wrong* rather than merely
/// wider: a snapshot covers the whole working tree, so anything another session
/// — or the user in their editor — changed in the same repo since that prompt
/// gets attributed to this one. A turn is short enough for that overlap to be
/// unlikely; a session is not.
export function changeRange(events: AgentEvent[]): ChangeRange {
  let head: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i].payload;
    // The newest head seen while walking back is the newest turn end overall,
    // which also covers a background subagent's report-back turn: its closing
    // snapshot is fresher than the prompt's own turn's and supersedes it.
    if (!head && payload.type === "turn_completed" && payload.head) {
      head = payload.head;
    }
    if (payload.type === "user_message" && payload.baseline) {
      return { baseline: payload.baseline, head };
    }
  }
  return { baseline: null, head: null };
}

/// Whether the last completed turn left the tree different from what it found.
///
/// Free and exact, so it needs no git call and no file list: both sides are
/// content-addressed tree ids, so ids that differ *are* a changed tree. A turn
/// that edited a file and put it back reads as unchanged, which is also what
/// the panel would show. A null head is a turn still running, where nothing is
/// settled yet.
export function turnChangedTree({ baseline, head }: ChangeRange): boolean {
  return !!baseline && !!head && baseline !== head;
}

/// Splits a path into the part that gets dimmed and the part that doesn't. The
/// basename is what the reader scans for, so it stays at full contrast while
/// the directories recede.
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  if (cut === -1) return { dir: "", name: path };
  return { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}
