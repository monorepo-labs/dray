import type { SessionIndexItem, SessionStatus } from "@/types/events";

/// One strip in the crew — the sessions a conversation has running — holding the
/// session and the three things a row says about it without being opened.
export type CrewRow = {
  item: SessionIndexItem;
  /// A turn is in flight. Draws the orb, and nothing else in the crew moves.
  busy: boolean;
  /// Standing still behind a card somebody has to answer. The sidebar's yellow,
  /// and the one state that opens a row on its own.
  asking: boolean;
  /// A turn finished and nobody has read it. The sidebar's green.
  unread: boolean;
};

/// What the selected session started, newest first. **Its own children and
/// nothing below them.**
///
/// The depth cap allows a spawned session to spawn, so a grandchild exists and
/// a walk would reach it. It is deliberately not drawn: a flat list cannot say
/// that one of its rows belongs to another, so a grandchild sat in the column
/// as a peer of the session that started it, and the reader had no way to tell
/// which. Drawing the tree instead is the other half of the same answer and is
/// refused for its own reasons — the sidebar already draws it, and a connector
/// between two headers is broken by whatever transcript is expanded between
/// them.
///
/// A grandchild is not unreachable, it is one hop away: ⌘-click the row that
/// started it and that session anchors a crew of its own. Which is the honest
/// reading of what this column is — *what this conversation is running*, not
/// everything downstream of it.
///
/// Archived sessions are dropped. A settled session is one the reader has
/// finished with, and the crew is a worklist — the sidebar's archived side is
/// where it goes on being listed.
export function crewRows(
  items: SessionIndexItem[],
  parentId: string | null,
  live: {
    statusBySession: Record<string, SessionStatus>;
    askingSessions: ReadonlySet<string>;
  },
): CrewRow[] {
  if (!parentId) return [];
  return items
    .filter((i) => i.parentSessionId === parentId && !i.archived && i.sessionId !== parentId)
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
    .map((item) => rowState(item, live));
}

/// What a row says about one session.
///
/// Live status wins over the index's, which is what carries a `completed`
/// across a restart and is stale the moment the session moves. `asking` is read
/// ahead of status and is not folded into it: the backend reports a session
/// blocked on a card as `in_progress` and is right to — the turn *is* still
/// open — so the two are separate questions and this one is the reader's.
function rowState(
  item: SessionIndexItem,
  live: {
    statusBySession: Record<string, SessionStatus>;
    askingSessions: ReadonlySet<string>;
  },
): CrewRow {
  const status = live.statusBySession[item.sessionId] ?? item.status;
  const asking = live.askingSessions.has(item.sessionId);
  return {
    item,
    asking,
    busy: !asking && status === "in_progress",
    unread: status === "completed",
  };
}

/// The session whose crew is on screen, which is *not* simply the selected one.
///
/// Opening a crew row selects that session — the composer has to follow where
/// the reader is reading — and a child has no children of its own, so read
/// straight off the selection the crew would delete itself on the first click
/// it received. Hence an anchor that survives its own rows being selected.
///
/// The rule is three lines and **the order of the first two is load-bearing**:
///
///  1. the previous anchor stands while the selection is one of its rows — so
///     the crew lives exactly as long as the reader is inside something it is
///     showing;
///  2. otherwise a session with descendants anchors its own crew;
///  3. otherwise there is no crew.
///
/// Asking 2 first looks equivalent and is not, because a spawned session may
/// spawn: clicking a row that has children of its own then made *that* session
/// the anchor, which swapped the whole list and moved the main column onto it —
/// reading as the crew row having replaced the conversation rather than opened
/// beside it. A session in the list is in the list, and what it started of its
/// own is deliberately not drawn here at all; ⌘-click is how you go and look.
///
/// Clause 1 is also narrower than "a child keeps its parent's crew". A child
/// reached from the sidebar shows no crew and is full width, which is the
/// settled behaviour: the crew lists what the selected session started, and
/// this one started nothing. What it does not do is punish the reader for using
/// the column they were given.
export function crewAnchor(
  items: SessionIndexItem[],
  selectedId: string | null,
  previous: string | null,
): string | null {
  if (!selectedId) return null;

  if (previous) {
    const quiet = { statusBySession: {}, askingSessions: new Set<string>() };
    const held = crewRows(items, previous, quiet).some((r) => r.item.sessionId === selectedId);
    if (held) return previous;
  }
  return items.some((i) => i.parentSessionId === selectedId && !i.archived) ? selectedId : null;
}
