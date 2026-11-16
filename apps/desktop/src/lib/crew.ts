import { botAt } from "@/lib/bots";
import type { NoticeKind } from "@/hooks/useNotices";
import type { BackgroundTask, Bot, SessionIndexItem, SessionStatus } from "@/types/events";

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
  /// No turn running, but a background shell or subagent still is: the same
  /// set the chat's Background Tasks row counts.
  background: boolean;
};

/// The live maps a row is read off.
type Live = {
  statusBySession: Record<string, SessionStatus>;
  askingSessions: ReadonlySet<string>;
  tasksBySession?: Record<string, BackgroundTask[]>;
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
/// session is one the reader has finished with. A bot's task is the exception:
/// its sub-tasks outlive it, and hang under the session that adopted them.
export function crewRows(
  items: SessionIndexItem[],
  parentId: string | null,
  state: Live,
  /// More sessions whose children count as the parent's: a bot chat's earlier
  /// sessions, from before it switched agent, whose tasks are still its own.
  also: readonly string[] = [],
): CrewRow[] {
  if (!parentId) return [];
  const live = new Map(items.filter((i) => !i.archived).map((i) => [i.sessionId, i]));
  const byParent = new Map<string, SessionIndexItem[]>();
  for (const i of items) {
    const parent = treeParent(i, live);
    if (i.archived || !parent || parent === i.sessionId) continue;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(i);
    byParent.set(parent, siblings);
  }
  const out: CrewRow[] = [];
  const roots = [parentId, ...also];
  // A cycle in the index costs a short list rather than a hung render.
  const seen = new Set(roots);
  const walk = (ids: readonly string[]) => {
    const kids = ids.flatMap((id) => byParent.get(id) ?? []).sort(
      (a, b) => Date.parse(b.created) - Date.parse(a.created),
    );
    for (const kid of kids) {
      if (seen.has(kid.sessionId)) continue;
      seen.add(kid.sessionId);
      out.push(rowState(kid, state));
      walk([kid.sessionId]);
    }
  };
  walk(roots);
  return out;
}

/// The session `item` hangs under: its parent while that is live, else the
/// one that adopted it when the parent was settled or deleted.
export function treeParent(
  item: SessionIndexItem,
  live: ReadonlyMap<string, SessionIndexItem> | ReadonlySet<string>,
): string | null {
  const p = item.parentSessionId;
  return p && live.has(p) ? p : item.adoptedBy ?? p;
}

/// What a row says about one session.
///
/// Live status wins over the index's, which is what carries a `completed`
/// across a restart and is stale the moment the session moves. `asking` is read
/// ahead of status and is not folded into it: the backend reports a session
/// blocked on a card as `in_progress` and is right to — the turn *is* still
/// open — so the two are separate questions and this one is the reader's.
function rowState(item: SessionIndexItem, live: Live): CrewRow {
  const status = live.statusBySession[item.sessionId] ?? item.status;
  const asking = live.askingSessions.has(item.sessionId);
  const busy = !asking && status === "in_progress";
  return {
    item,
    asking,
    busy,
    unread: status === "completed",
    background: !asking && !busy && (live.tasksBySession?.[item.sessionId]?.length ?? 0) > 0,
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

/// The sidebar's list: everything but a hidden session whose parent is here,
/// and a bot's ongoing chat, which the Bots section draws. A bot's *settled*
/// chats stay, since the settled list is the only way back to one. A hidden
/// session surfaces through its cards beside that parent and the bot's Tasks
/// tab. A bot's sub-task whose parent is settled counts the session that
/// adopted it as its parent. One whose parent is missing stays listed, since
/// it would surface nowhere. Settled ones too: unsettling the parent lists
/// them again.
///
/// `all` is every session held, which is where the parent is looked for: a
/// bot's chat sits in the bot's folder, so a project filter on `items` drops it
/// and its tasks would read as orphans.
export function inSidebar(
  items: SessionIndexItem[],
  bots: readonly Bot[] = [],
  all: readonly SessionIndexItem[] = items,
): SessionIndexItem[] {
  const ids = new Set(all.map((i) => i.sessionId));
  return items.filter(
    (i) =>
      !(i.hidden && ids.has(treeParent(i, ids) ?? "")) &&
      !(!i.archived && botAt(bots, i.cwd)),
  );
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
    let up = at && treeParent(at, byId);
    while (at?.hidden && up && !out.has(up)) {
      out.add(up);
      at = byId.get(up);
      up = at && treeParent(at, byId);
    }
  }
  return out;
}

/// Whether a session's news of this kind is left to the session that started
/// it. A hidden one is a bot's task or a reviewer, and its parent already
/// reports on it, so its finishing and its PR turning ready raise nothing here.
/// A card is the exception: only the reader can answer it.
export function leftToParent(
  item: Pick<SessionIndexItem, "hidden"> | undefined,
  kind: NoticeKind | undefined,
): boolean {
  return !!item?.hidden && (kind === "completed" || kind === "pr");
}

/// The hidden sessions `parentId` started directly, or adopted. Settle, delete
/// and worktree removal carry on to these, since nothing else on screen can
/// reach them — unless `parentId` is a bot's task, whose sub-tasks outlive it.
export function hiddenChildren(items: SessionIndexItem[], parentId: string): SessionIndexItem[] {
  return items.filter(
    (i) => i.hidden && (i.parentSessionId === parentId || i.adoptedBy === parentId) && i.sessionId !== parentId,
  );
}
