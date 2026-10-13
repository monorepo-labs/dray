import type { AgentEvent } from "@/types/events";

type Range = {
  /// The prompt's snapshot — the "before" side. Null when there is nothing to
  /// diff against, which is ordinary rather than an error: a session in a
  /// plain directory records no snapshots, and neither does one whose prompts
  /// predate the field.
  baseline: string | null;
  /// The snapshot the turn's own `turn_completed` carried — the "after" side,
  /// frozen when the turn finished. Null while the turn is still running (or
  /// for one that never closed), which the panel reads as "diff against the
  /// working tree as it stands now".
  head: string | null;
};

type ChangeRange = Range & {
  /// The newest finished turn before this one that changed something. Set only
  /// while this one is still running: its live diff may yet be empty, and the
  /// panel shows this in its place rather than going blank on send.
  previous: Range | null;
};

/// The two trees the panel diffs: a prompt's baseline, and the frozen head of
/// the turn that completed *after* it — the newest turn that changed anything.
///
/// A finished turn whose head equals its baseline changed nothing (trees are
/// content-addressed, so equal ids are equal contents) and is skipped for the
/// turn before it. A question asked about the code keeps the diff it was about
/// on screen; only a turn that writes replaces it.
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
/// Deliberately one turn. A session-wide baseline is the same code
/// reading a different prompt, but it would be *wrong* rather than merely
/// wider: a snapshot covers the whole working tree, so anything another session
/// — or the user in their editor — changed in the same repo since that prompt
/// gets attributed to this one. A turn is short enough for that overlap to be
/// unlikely; a session is not.
export function changeRange(events: AgentEvent[]): ChangeRange {
  let head: string | null = null;
  // The newest turn whatever it did, for when none changed anything: the panel
  // then says so, rather than claiming there is no snapshot at all.
  let newest: Range | null = null;
  let running: Range | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i].payload;
    // The newest head seen walking back to a prompt is that turn's end, which
    // also covers a background subagent's report-back turn: its closing
    // snapshot is fresher than the prompt's own turn's and supersedes it.
    if (!head && payload.type === "turn_completed" && payload.head) {
      head = payload.head;
    }
    if (payload.type !== "user_message" || !payload.baseline) continue;
    const range = { baseline: payload.baseline, head };
    head = null;
    newest ??= range;
    if (range.head === range.baseline) continue;
    if (range.head) {
      return running ? { ...running, previous: range } : { ...range, previous: null };
    }
    // Only the newest turn can still be running. An older one left open never
    // closed, and diffing it against "now" is what the frozen head avoids.
    if (range === newest) running = range;
  }
  return { ...(running ?? newest ?? { baseline: null, head: null }), previous: null };
}

/// The newest finished tool call's id, or "" where there is none.
///
/// What tells a working-tree read to re-read mid-turn. Only a tool can write,
/// so text, reasoning and progress events moving `events.length` asked for a
/// `git add -A` snapshot each and could never change its answer.
export function lastToolResult(events: AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].payload.type === "tool_call_completed") return events[i].id;
  }
  return "";
}

/// Splits a path into the part that gets dimmed and the part that doesn't. The
/// basename is what the reader scans for, so it stays at full contrast while
/// the directories recede.
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  if (cut === -1) return { dir: "", name: path };
  return { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}
