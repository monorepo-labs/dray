/// Where split groups are stored. Frontend-only, like the space list: a group
/// is a way of looking at sessions, so losing one costs the view and never the
/// work.
export const GROUPS_KEY = "ade.splitGroups";

/// A grid is at most two columns of at most two panes — four transcripts, and
/// past that a pane is too narrow to read one in.
const MAX_COLUMNS = 2;
const MAX_ROWS = 2;

export type SplitGroup = {
  /// Names the group — "Group 3" — and survives other groups dissolving.
  id: number;
  /// Left to right, each top to bottom. Every column holds at least one pane.
  columns: string[][];
  /// The space it was made in. A group made with every project up lives there
  /// alone and is not drawn inside any one space.
  space: string | null;
};

/// Where on a pane a row is let go. `center` replaces the pane; the edges open
/// beside it — above and below within its column, left and right as a column
/// of their own.
export type Region = "center" | "top" | "bottom" | "left" | "right";

export const groupName = (group: { id: number }) => `Group ${group.id}`;

/// Grid order: left to right, top to bottom. The sidebar's run reads the same.
export const members = (group: SplitGroup): string[] => group.columns.flat();

export function groupOf(
  groups: SplitGroup[],
  sessionId: string | null,
): SplitGroup | undefined {
  return sessionId
    ? groups.find((g) => members(g).includes(sessionId))
    : undefined;
}

/// The columns with one session taken out and any column it emptied dropped.
function without(columns: string[][], sessionId: string): string[][] {
  return columns
    .map((c) => c.filter((id) => id !== sessionId))
    .filter((c) => c.length > 0);
}

/// The columns with `dropped` landed on `anchor`'s pane at `region`, or `null`
/// where there is no room. A session already in the grid is *moved*: taken
/// out first, then placed, so dragging a pane's row onto another pane
/// rearranges rather than duplicates.
export function place(
  columns: string[][],
  anchor: string,
  dropped: string,
  region: Region,
): string[][] | null {
  if (anchor === dropped) return null;
  const cols = without(columns, dropped);
  const ci = cols.findIndex((c) => c.includes(anchor));
  if (ci === -1) return null;
  const col = cols[ci];
  const ri = col.indexOf(anchor);

  switch (region) {
    case "center":
      return cols.map((c, i) =>
        i === ci ? c.map((id) => (id === anchor ? dropped : id)) : c,
      );
    case "top":
    case "bottom": {
      if (col.length >= MAX_ROWS) return null;
      const next = [...col];
      next.splice(region === "top" ? ri : ri + 1, 0, dropped);
      return cols.map((c, i) => (i === ci ? next : c));
    }
    case "left":
    case "right": {
      if (cols.length >= MAX_COLUMNS) return null;
      const next = [...cols];
      next.splice(region === "left" ? ci : ci + 1, 0, [dropped]);
      return next;
    }
  }
}

const REGION_LABELS: Record<Region, string> = {
  center: "Replace",
  top: "Open above",
  bottom: "Open below",
  left: "Open on the left",
  right: "Open on the right",
};

/// What dropping `dropped` on `anchor`'s pane at `region` would do, as the
/// sentence the drop zone draws, or `null` where nothing would happen. `groups`
/// is the active space's own; a group elsewhere is not on screen to drop into.
export function dropLabel(
  groups: SplitGroup[],
  anchor: string,
  dropped: string,
  region: Region,
): string | null {
  const target = groupOf(groups, anchor);
  // Replacing a single view is opening the session, which a click already
  // does — so it is no drop at all.
  if (!target && region === "center") return null;
  if (!place(target?.columns ?? [[anchor]], anchor, dropped, region)) return null;
  return REGION_LABELS[region];
}

/// Puts `dropped` on `anchor`'s pane at `region`: into the anchor's group in
/// this space, or into a new group of the two. A session sits in one group at
/// most, so both leave any other first — which can dissolve that one. The
/// anchor's group in *another* space counts as another: it is not on screen
/// here, and building on it would open nothing the reader can see.
export function openBeside(
  groups: SplitGroup[],
  anchor: string,
  dropped: string,
  region: Region,
  space: string | null,
): SplitGroup[] {
  const here = (g: SplitGroup) => g.space === space;
  if (!dropLabel(groups.filter(here), anchor, dropped, region)) return groups;

  const target = groups.find((g) => here(g) && members(g).includes(anchor));
  let rest = groups;
  for (const id of [dropped, anchor]) {
    const old = groupOf(rest, id);
    if (old && old !== target) rest = closePane(rest, id);
  }

  const columns = place(target?.columns ?? [[anchor]], anchor, dropped, region);
  if (!columns) return groups;
  if (target) {
    return rest
      .map((g) => (g === target ? { ...g, columns } : g))
      .filter((g) => members(g).length >= 2);
  }
  const id = Math.max(0, ...rest.map((g) => g.id)) + 1;
  return [...rest, { id, columns, space }];
}

/// The sidebar's order with each group's run folded into one step, for a chord
/// that walks groups rather than rows. Only *consecutive* members fold — a
/// group's run is drawn together, so that is every member — and a row in no
/// group is a step of its own.
export function stepUnits<T>(rows: T[], groups: SplitGroup[], id: (row: T) => string): T[][] {
  const units: T[][] = [];
  const unitOf = (row: T) => groupOf(groups, id(row))?.id ?? id(row);
  for (const row of rows) {
    const last = units[units.length - 1];
    if (last && unitOf(last[0]) === unitOf(row)) last.push(row);
    else units.push([row]);
  }
  return units;
}

/// Takes one session out of its group. A group left with one member is no
/// group, so it goes too.
export function closePane(groups: SplitGroup[], sessionId: string): SplitGroup[] {
  return groups
    .map((g) =>
      members(g).includes(sessionId) ? { ...g, columns: without(g.columns, sessionId) } : g,
    )
    .filter((g) => members(g).length >= 2);
}

/// Drops members the index no longer lists — deleted or archived. Answers the
/// same array where nothing changed, so a caller can skip the write.
export function pruneGroups(groups: SplitGroup[], present: Set<string>): SplitGroup[] {
  let changed = false;
  const next = groups
    .map((g) => {
      const kept = g.columns.map((c) => c.filter((id) => present.has(id))).filter((c) => c.length);
      if (members({ ...g, columns: kept }).length === members(g).length) return g;
      changed = true;
      return { ...g, columns: kept };
    })
    .filter((g) => {
      if (members(g).length >= 2) return true;
      changed = true;
      return false;
    });
  return changed ? next : groups;
}
