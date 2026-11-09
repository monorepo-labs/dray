import type { SessionIndexItem, SessionStatus } from "@/types/events";

/// One session the selected one started, and what it is doing.
export type CrewRow = {
  item: SessionIndexItem;
  /// A turn is in flight.
  busy: boolean;
  /// Standing still behind a card somebody has to answer. The one state that
  /// puts a row in the crew column.
  asking: boolean;
  /// A turn finished and nobody has read it. The sidebar's green.
  unread: boolean;
};

/// Everything the selected session started, at any depth: depth-first, each
/// level newest first. The crew column draws the rows asking.
///
/// Every depth, since a grandchild's card would otherwise surface only while
/// its own parent is selected — and a hidden parent is never the selection.
///
/// Newest first by when it was *started* rather than last touched: the
/// sidebar's own ordering moves a row every time its turn ends.
///
/// Archived sessions are dropped, with everything under them: a settled
/// session is one the reader has finished with.
export function crewRows(
  items: SessionIndexItem[],
  parentId: string | null,
  live: {
    statusBySession: Record<string, SessionStatus>;
    askingSessions: ReadonlySet<string>;
  },
): CrewRow[] {
  if (!parentId) return [];
  const byParent = new Map<string, SessionIndexItem[]>();
  for (const i of items) {
    if (i.archived || !i.parentSessionId || i.parentSessionId === i.sessionId) continue;
    const siblings = byParent.get(i.parentSessionId) ?? [];
    siblings.push(i);
    byParent.set(i.parentSessionId, siblings);
  }
  const out: CrewRow[] = [];
  // A cycle in the index costs a short list rather than a hung render.
  const seen = new Set([parentId]);
  const walk = (id: string) => {
    const kids = [...(byParent.get(id) ?? [])].sort(
      (a, b) => Date.parse(b.created) - Date.parse(a.created),
    );
    for (const kid of kids) {
      if (seen.has(kid.sessionId)) continue;
      seen.add(kid.sessionId);
      out.push(rowState(kid, live));
      walk(kid.sessionId);
    }
  };
  walk(parentId);
  return out;
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

/// The sessions whose cards the crew column would draw: every row, asking or
/// not, wherever the column can appear.
///
/// Not the question `crewShown` in `App` asks, which is narrower on purpose:
/// that set is what gets loaded and read-marked. This one answers whether a
/// card raised for a session would land in front of the reader — and the
/// column draws one for any row, so membership alone is the whole answer.
///
/// **Never filtered by `asking`.** That flag is set by the very event being
/// announced, so a set filtered by it is always one render behind the question:
/// `announce` found the child not yet on screen and raised a notice, and the
/// column drew its card a render later anyway — a card and a notice for one
/// event (DRA-277).
///
/// Empty where the column cannot appear — behind another view tab, on the
/// issues page, or beside a split — since a card nobody can see must announce.
export function crewSeen(rows: CrewRow[], drawn: boolean): string[] {
  return drawn ? rows.map((r) => r.item.sessionId) : [];
}

/// The sidebar's list: everything but a hidden session whose parent is here.
/// A hidden session surfaces only through its cards beside that parent. One
/// whose parent is missing stays listed, since it would surface nowhere. Settled ones too:
/// unsettling the parent lists them again.
export function inSidebar(items: SessionIndexItem[]): SessionIndexItem[] {
  const ids = new Set(items.map((i) => i.sessionId));
  return items.filter((i) => !(i.hidden && i.parentSessionId && ids.has(i.parentSessionId)));
}

/// `asking` with every hidden asker's ancestors added, for the sidebar. A hidden
/// session has no row there, so a card it raised would otherwise leave its
/// parent looking idle and the session blocked with nobody told.
export function withHiddenAsks(
  items: SessionIndexItem[],
  asking: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(items.map((i) => [i.sessionId, i]));
  const out = new Set(asking);
  for (const id of asking) {
    let at = byId.get(id);
    // `out` doubles as the cycle guard: a parent already marked stops the walk.
    while (at?.hidden && at.parentSessionId && !out.has(at.parentSessionId)) {
      out.add(at.parentSessionId);
      at = byId.get(at.parentSessionId);
    }
  }
  return out;
}

/// The hidden sessions `parentId` started directly. Settle, delete and worktree
/// removal carry on to these, since nothing else on screen can reach them.
export function hiddenChildren(items: SessionIndexItem[], parentId: string): SessionIndexItem[] {
  return items.filter((i) => i.hidden && i.parentSessionId === parentId && i.sessionId !== parentId);
}
