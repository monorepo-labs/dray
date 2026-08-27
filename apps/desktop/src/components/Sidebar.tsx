import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  ChevronDown,
  CircleDashed,
  CircleDot,
  GitBranchPlus,
  Unlink,
  Inbox,
  Pin,
  Plus,
  Search,
  Settings,
  Trash2,
  Undo2,
} from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";

import PrStateIcon, { prStateLabel } from "@/components/PrStateIcon";
import UpdateRow from "@/components/UpdateRow";
import PanelLeftIcon from "@/components/icons/PanelLeftIcon";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFullscreen } from "@/hooks/useFullscreen";
import { burstConfetti } from "@/lib/confetti";
import type { ManualCheck } from "@/hooks/useUpdater";
import { isToday, relativeTime } from "@/lib/format";
import { sessionBranch } from "@/lib/pr";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type {
  PrMark,
  Project,
  SessionIndexItem,
  SessionStatus,
  UpdateStatus,
} from "@/types/events";

type SidebarProps = {
  // Already scoped to `projectFilter` and to `search` by the caller, so the list
  // and the ⌘⇧↑/↓ walk step through exactly the same rows.
  items: SessionIndexItem[];
  // The live search query. Owned by the caller, because the list it narrows is
  // the caller's — the ⌘⇧↑/↓ walk reads the same array, and a query kept in here
  // would leave the shortcut stepping rows the sidebar no longer draws.
  search: string;
  onSearchChange: (query: string) => void;
  // The live status of every session the app has heard about this run. Wins over
  // the item's own field, which is only as fresh as the last list fetch.
  statusBySession: Record<string, SessionStatus>;
  // Sessions standing still behind a permission request or a question. Kept
  // apart from `statusBySession` rather than folded into it: the backend's
  // status machine still reads these as `in_progress`, and it is right to —
  // the turn is open, it is only the agent that has stopped.
  askingSessions: Set<string>;
  /// The pull request this session's branch is marked with — open, draft or
  /// merged — or nothing. A lookup rather than a field on the item, because
  /// pull requests are read per repo and the index knows nothing about them.
  prFor: (repoPath: string, branch: string | null) => PrMark | undefined;
  selectedSessionId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenSettings: () => void;
  onSelect: (sessionId: string) => void;
  onNewSession: () => void;
  /// Opens the issues page in the main column. It is not a session, so it does
  /// not move the selection — coming back from it lands on the session that was
  /// open before.
  onOpenIssues: () => void;
  /// The issues page is the thing on screen, so the row draws as the current
  /// one. Read here rather than derived from the selection, which the page
  /// deliberately leaves alone.
  issuesOpen: boolean;
  onSetFlags: (
    sessionId: string,
    flags: { archived?: boolean; pinned?: boolean },
  ) => Promise<void>;
  onFork: (sessionId: string, worktree: boolean) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
  onDetach: (sessionId: string) => Promise<void>;
  showArchived: boolean;
  onToggleArchived: () => void;
  projects: Project[];
  // `null` is every project, and it is the entry the filter opens on.
  projectFilter: string | null;
  onProjectFilterChange: (path: string | null) => void;
  updateStatus: UpdateStatus | null;
  // Any session mid-turn, not just the open one — installing relaunches the
  // whole app.
  updateBlocked: boolean;
  updateManual: ManualCheck;
  onInstallUpdate: () => void;
};

/// One drawn row: the session, how deep it sits, and the flags its connector
/// rails are drawn from.
export type SessionListRow = {
  item: SessionIndexItem;
  /// Levels below the top. 0 is a root and draws no connector at all.
  depth: number;
  /// One entry per level *above* this row, saying whether that level's rail
  /// carries on below it. The last entry is this row's own parent — false there
  /// closes the line at the elbow, so a rail never runs on into an unrelated
  /// session.
  guides: boolean[];
  /// This row opens a rail of its own for the rows under it.
  opens: boolean;
};

/// The order the list is drawn in, with a session spawned by an agent sitting
/// directly under the one that spawned it — and the depth and guide flags each
/// row's rails are drawn from.
///
/// Order and rails come out of this one walk on purpose. Computing the rails
/// separately would let the shape drawn down the left edge disagree with the
/// order the rows are actually in, and a rail pointing at the wrong row says
/// something false about who spawned what.
///
/// A child whose parent is not in `items` is drawn at the top level rather than
/// hidden. That is the ordinary case, not an edge one: the parent may be
/// archived, filtered to another project, or deleted outright, and a row that
/// vanished with it would be unreachable — so it draws as a root, with no rail
/// reaching for a parent that isn't there.
///
/// Depth is drawn rather than flattened: the cap allows a spawned session to
/// spawn, so a grandchild exists, and it hangs off its own parent's rail while
/// that parent still hangs off the root's.
export function sessionRows(items: SessionIndexItem[]): SessionListRow[] {
  const byRecency = (a: SessionIndexItem, b: SessionIndexItem) =>
    Date.parse(b.modified) - Date.parse(a.modified);

  const present = new Set(items.map((i) => i.sessionId));
  const parentOf = (i: SessionIndexItem) =>
    i.parentSessionId && present.has(i.parentSessionId) ? i.parentSessionId : null;

  const children = new Map<string, SessionIndexItem[]>();
  for (const item of items) {
    const parent = parentOf(item);
    if (!parent) continue;
    const group = children.get(parent);
    if (group) group.push(item);
    else children.set(parent, [item]);
  }

  // Depth-first rather than one pass over roots and their direct children: the
  // depth cap allows a spawned session to spawn, so a grandchild exists, and a
  // single pass emitted neither it nor anything below it — the row simply
  // vanished from the sidebar. Pinned by a test.
  const rows: SessionListRow[] = [];
  const seen = new Set<string>();

  const walk = (item: SessionIndexItem, depth: number, guides: boolean[]) => {
    if (seen.has(item.sessionId)) return;
    seen.add(item.sessionId);
    const row: SessionListRow = { item, depth, guides, opens: false };
    rows.push(row);

    // Filtered before the walk, not during it: the last *drawn* child is what
    // closes the rail, and a cycle can leave a listed child already emitted
    // elsewhere — counting it would run the rail on past the row it ends at.
    const kids = (children.get(item.sessionId) ?? [])
      .filter((child) => !seen.has(child.sessionId))
      .sort(byRecency);
    const before = rows.length;
    kids.forEach((child, i) => {
      walk(child, depth + 1, [...guides, i < kids.length - 1]);
    });
    row.opens = rows.length > before;
  };

  for (const root of [...items].filter((i) => !parentOf(i)).sort(byRecency)) {
    walk(root, 0, []);
  }

  // A cycle in the index reaches no root, so its rows are still unemitted here.
  // Appended rather than dropped: the sidebar losing a session is worse than
  // drawing a strange order, and `seen` is what stops the walk itself hanging.
  for (const stranded of [...items].sort(byRecency)) {
    walk(stranded, 0, []);
  }

  return rows;
}

/// One run of rows drawn under a single heading, in the order the sidebar draws
/// them.
///
/// Pinned is a kind of its own rather than another path, because it is the one
/// group that spans projects — a path on it could only be a lie or a null, and
/// either leaves the render guessing which sort of group it is holding.
export type SessionGroup =
  | { kind: "pinned"; rows: SessionListRow[] }
  | { kind: "project"; projectPath: string; rows: SessionListRow[] };

/// The items that draw in the Pinned group, and everything else.
///
/// A session is pinned-side when it *or an ancestor* is pinned, so a pinned
/// session's children follow it out of its project's run — leaving them behind
/// would split one nest across two headings and draw children under a parent
/// that isn't there.
///
/// What falls out of that rule: the rest is closed under parentage, since
/// nothing with a pinned ancestor can stay in it. So both halves hold whole
/// nests, and [`sessionRows`] draws each half's own roots at depth 0 — a pinned
/// child whose parent stayed behind reaches the Pinned group as a root, with no
/// rail reaching for a row drawn somewhere else entirely.
function splitPinned(
  items: SessionIndexItem[],
): [pinned: SessionIndexItem[], rest: SessionIndexItem[]] {
  const byId = new Map(items.map((i) => [i.sessionId, i]));

  const underPin = (item: SessionIndexItem) => {
    // Guarded like the walk itself: a cycle in the index has to cost a strange
    // grouping, never a hung sidebar.
    const seen = new Set<string>();
    let at: SessionIndexItem | undefined = item;
    while (at && !seen.has(at.sessionId)) {
      if (at.pinned) return true;
      seen.add(at.sessionId);
      at = at.parentSessionId ? byId.get(at.parentSessionId) : undefined;
    }
    return false;
  };

  const pinned: SessionIndexItem[] = [];
  const rest: SessionIndexItem[] = [];
  for (const item of items) (underPin(item) ? pinned : rest).push(item);
  return [pinned, rest];
}

/// [`sessionRows`] gathered under the project each row's *root* belongs to,
/// with the reader's own pins led out into a group of their own.
///
/// **Pinned leads, whatever the project order says.** It is the one group built
/// by hand, and a pick that sorted in with the rest would be no easier to find
/// than the rows it was made out of. It spans projects besides, so there is no
/// place in that order for it to take. A pinned session draws there and nowhere
/// else — drawn twice, the reader has to work out which copy is the one they
/// pinned.
///
/// A project filter needs nothing here: the caller narrows `items` before this
/// sees them, so the Pinned group holds that project's pins alone and opens no
/// group at all when it holds none.
///
/// Grouped on the root rather than on the row: a spawned session hangs off its
/// parent wherever its own `projectPath` points, and splitting one nest across
/// two headings would draw a child under a parent that isn't there.
///
/// A project with no session opens no group, which is the whole of "don't show
/// an empty project" — headings come from the sessions present, never from the
/// attached list.
///
/// **Group order is the project list's own**, not the recency of the sessions
/// inside it. Ordering on the newest session read well for one screenshot and
/// badly in use: every reply to any session lifted its whole project over the
/// others, so headings the eye had learned the position of moved while a turn
/// was running. The project list only reorders when a project is *selected*,
/// which is the reader's own act. A project no longer attached still has
/// sessions to draw, so it keeps first-appearance order after the attached
/// ones.
///
/// Rows inside a group stay newest-first, and a list already narrowed to one
/// project comes back in exactly the order it had before grouping existed.
export function sessionGroups(
  items: SessionIndexItem[],
  projects: Project[] = [],
): SessionGroup[] {
  const [pinned, rest] = splitPinned(items);

  type ProjectGroup = Extract<SessionGroup, { kind: "project" }>;
  const groups: ProjectGroup[] = [];
  const byPath = new Map<string, ProjectGroup>();
  let current: ProjectGroup | undefined;

  for (const row of sessionRows(rest)) {
    // Every subtree the walk emits opens with its own root, so a depth-0 row is
    // where one run ends and the next begins.
    if (row.depth === 0 || !current) {
      const path = row.item.projectPath;
      current = byPath.get(path);
      if (!current) {
        current = { kind: "project", projectPath: path, rows: [] };
        byPath.set(path, current);
        groups.push(current);
      }
    }
    current.rows.push(row);
  }

  // Unattached sorts to the end rather than to the front, and `sort` is stable,
  // so those keep the order they were built in.
  const rank = new Map(projects.map((p, i) => [p.path, i]));
  const place = (group: ProjectGroup) =>
    rank.get(group.projectPath) ?? Number.MAX_SAFE_INTEGER;

  groups.sort((a, b) => place(a) - place(b));

  const pinnedRows = sessionRows(pinned);
  return pinnedRows.length
    ? [{ kind: "pinned", rows: pinnedRows }, ...groups]
    : groups;
}

/// The order alone, for callers that only step through it.
///
/// Exported because the ⌘⇧↑/↓ shortcut walks the same sequence, and a second
/// comparator would let the two disagree about which row is "next" — worse when
/// the sidebar is collapsed and nothing on screen shows the order being walked.
/// Grouped for the same reason: the shortcut has to step past a heading the way
/// the eye does, so it takes the same project list the headings are ordered by —
/// and it steps the pins first, because that is where the eye starts too.
export function sortSessions(
  items: SessionIndexItem[],
  projects: Project[] = [],
): SessionIndexItem[] {
  return sessionGroups(items, projects).flatMap((group) =>
    group.rows.map((row) => row.item),
  );
}

/// The rows a query leaves on screen, matched on `title` alone.
///
/// Applied *before* grouping, so a heading only draws where a group still holds
/// a row, and before `sortSessions` flattens the result, so ⌘⇧↑/↓ steps exactly
/// the rows drawn.
///
/// That ordering is what settles the pins too, and it needs no code of its own:
/// [`splitPinned`] sees the narrowed list, so a pin that matches stays in the
/// Pinned group and one that doesn't goes with every other row that didn't
/// match. Moving a matching pin down into its project's run would say the pin
/// had been dropped, and which rows the reader chose is the one thing that
/// group exists to say.
///
/// Substring and case-insensitive, deliberately no more than that. Fuzzy
/// matching ranks, and a ranked list cannot stay in the recency order the rails
/// are drawn from — a child would sit under whatever scored above it rather
/// than under its parent. The titles here are one line of the reader's own
/// words, so a substring finds them.
///
/// A blank query hands the same array back, identity included, so the memo over
/// this holds while nothing is being searched for.
///
/// Narrows what is already on screen: the caller passes the list `projectFilter`
/// and the active/settled split have already scoped, and search never reaches
/// past either.
export function filterSessions(
  items: SessionIndexItem[],
  query: string,
): SessionIndexItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => item.title.toLowerCase().includes(needle));
}

/// Whether a row has a parent to detach from, judged the same way
/// [`sessionRows`] places it — a parent that isn't on screen means the row is
/// drawn at the top level, so the menu item can never offer to cut a link the
/// list doesn't draw.
export function isNested(item: SessionIndexItem, items: SessionIndexItem[]): boolean {
  return Boolean(
    item.parentSessionId && items.some((i) => i.sessionId === item.parentSessionId),
  );
}

/// Sidebar toggle. Lives outside `Sidebar` because a collapsed sidebar renders
/// nothing at all — the button has to survive its own pane disappearing, so the
/// app header owns it and its y position never moves.
export function SidebarToggle({
  onToggle,
  collapsed = false,
}: {
  onToggle: () => void;
  collapsed?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Held back at rest — it's chrome, not content — and brought to full
            strength under the cursor. */}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggle}
          aria-label="Toggle sidebar"
          className="opacity-80 transition-opacity hover:opacity-100"
        >
          <PanelLeftIcon className="size-4.5" dim={collapsed} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        Toggle Sidebar
        <KbdGroup>
          <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>B</Kbd>
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  );
}

/// Opens the settings dialog.
///
/// Shares the titlebar strip with the sidebar toggle rather than sitting in the
/// filter row below it: settings are app-wide, and every control in that row
/// scopes the list under it.
///
/// Gone with a collapsed sidebar, since the sidebar is. ⌘, is the route that
/// survives that, which is why the tooltip names it.
export function SettingsButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpen}
          aria-label="Settings"
          className="opacity-80 transition-opacity hover:opacity-100"
        >
          <Settings className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        Settings
        <KbdGroup>
          <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>,</Kbd>
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  );
}

/// What the dev badge says for a given branch.
///
/// On `main` it stays bare: that is the common case, and naming the default
/// branch is a word the reader skips every time to reach the one that matters.
/// A worktree's branch is already `worktree-<name>`, so the prefix goes and the
/// badge names the tree the way the sidebar and `dray ls` do — stripped after
/// the `main` test, or a tree named `main` would read as no branch at all.
export function devBadgeLabel(branch: string | null): string {
  if (branch === null || branch === "" || branch === "main") return "Dev";
  return `Dev · ${branch.replace(/^worktree-/, "")}`;
}

/// Marks a dev build so it can't be mistaken for the installed app, and names
/// the checkout it runs from — with several worktrees open, two dev builds are
/// otherwise identical.
///
/// Gated on `import.meta.env.DEV`, which Vite folds to a constant, so this
/// component and the branch it reads both drop out of a production bundle.
///
/// Muted, and at the sidebar's bottom edge: it marks the build rather than
/// offering anything to act on, so it belongs with the standing information and
/// not beside the app's name, and the orange it wore made the corner's quietest
/// fact its loudest. One line — a long branch truncates rather than pushing the
/// row, with `title` restoring it.
export function DevBadge() {
  return (
    <div
      title={__DEV_BRANCH__ ?? undefined}
      className="shrink-0 truncate px-3.5 pb-2 font-mono text-[10px] leading-none text-muted-foreground/60"
    >
      {devBadgeLabel(__DEV_BRANCH__)}
    </div>
  );
}

export default function Sidebar({
  items,
  search,
  onSearchChange,
  statusBySession,
  askingSessions,
  prFor,
  selectedSessionId,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onNewSession,
  onOpenIssues,
  issuesOpen,
  onSetFlags,
  onFork,
  onDelete,
  showArchived,
  onToggleArchived,
  projects,
  projectFilter,
  onDetach,
  onProjectFilterChange,
  updateStatus,
  updateBlocked,
  updateManual,
  onInstallUpdate,
  onOpenSettings,
}: SidebarProps) {
  const fullscreen = useFullscreen();

  // Whether the search row is drawn as an input rather than as its button. Kept
  // apart from the query itself: the empty input and the button look the same,
  // so this is only about where the caret is.
  const [searching, setSearching] = useState(false);

  const closeSearch = () => {
    setSearching(false);
    onSearchChange("");
  };

  // Recency-ordered, with agent-spawned sessions nested under the one that
  // spawned them, and each row carrying the flags its connector rails are drawn
  // from — then gathered under the project it belongs to, in the project list's
  // own order, so the all-projects view reads as one list per repo and the
  // headings hold still while its sessions work.
  const groups = useMemo(() => sessionGroups(items, projects), [items, projects]);
  const rowCount = useMemo(
    () => groups.reduce((n, group) => n + group.rows.length, 0),
    [groups],
  );

  // A session under a repo nobody attached still has a project, so the folder
  // name stands in rather than the heading being dropped — the row has to sit
  // under something.
  const projectName = useMemo(() => {
    const named = new Map(projects.map((p) => [p.path, p.name]));
    return (path: string) =>
      named.get(path) ?? path.split("/").filter(Boolean).pop() ?? path;
  }, [projects]);

  // A filtered list that comes up empty is a different fact from an empty app,
  // and saying "No tasks yet" over a filter reads as data loss. The query leads
  // where there is one: it is the filter the reader is holding in their hands,
  // where the project and the settled split were already on screen.
  const emptyText = search.trim()
    ? `No tasks matching "${search.trim()}".`
    : projectFilter
      ? showArchived
        ? "Nothing settled in this project."
        : "No tasks in this project."
      : showArchived
        ? "Nothing settled yet."
        : "No tasks yet.";

  // Collapsed is nothing at all, not a rail. The toggle moves to the app header
  // in that state, which is the one row present either way.
  if (collapsed) return null;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border">
      {/* The toggle shares this strip with the traffic lights, so it sits at the
          right to clear them — except in fullscreen, where they're gone and the
          left edge is free. */}
      <div
        className={cn(
          "flex h-(--titlebar-h) shrink-0 items-center px-2",
          // Left-aligned, the toggle's larger icon would sit 2px inside the
          // buttons below it; nudge it out so every icon shares one edge.
          fullscreen ? "justify-start pl-2" : "justify-end",
        )}
        data-tauri-drag-region="deep"
      >
        {/* The toggle holds the strip's outer edge in both layouts and settings
            sit inboard of it, so the one control also drawn in the app header
            never changes which end of the row it is at. */}
        {fullscreen ? (
          <>
            <SidebarToggle onToggle={onToggleCollapsed} />
            <SettingsButton onOpen={onOpenSettings} />
          </>
        ) : (
          <>
            <SettingsButton onOpen={onOpenSettings} />
            <SidebarToggle onToggle={onToggleCollapsed} />
          </>
        )}
      </div>

      {/* `px-1.5` on the buttons rather than `size="sm"`'s `px-2.5`, so their
          icons land on the same 12px inset as the toggle above. */}
      <div className="flex flex-col gap-px px-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewSession}
          className="w-full justify-start px-1.5 text-ui"
        >
          <Plus />
          New Task
          <KbdGroup className="ml-auto">
            <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
            <Kbd>N</Kbd>
          </KbdGroup>
        </Button>

        {/* Under New Task, because it is the other way a task starts — an
            issue is a task somebody already wrote down. Drawn whether or not a
            tracker is connected: the page's own empty state is where connecting
            is offered, and a row that only appears once you have found the
            settings dialog can only be found by people who did not need it. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenIssues}
          data-active={issuesOpen || undefined}
          className="w-full justify-start px-1.5 text-ui data-[active]:bg-sidebar-accent data-[active]:text-sidebar-accent-foreground"
        >
          <CircleDot />
          Issues
        </Button>

        {/* The button *becomes* the field, on the same row at the same height:
            the icon holds its place, the caret lands where the label was, and
            nothing below it moves. Bare on purpose — a fill, a border or a
            focus ring here would draw a second kind of control into a strip
            that is otherwise plain buttons. The transparent border is what holds
            that promise to the pixel: every button carries one, so the icon
            would sit a pixel further out without it. */}
        {searching ? (
          <div className="flex h-7 w-full items-center gap-1 border border-transparent px-1.5 text-ui">
            <Search className="size-3.5 shrink-0" />
            <input
              autoFocus
              type="text"
              value={search}
              placeholder="Search"
              aria-label="Search tasks"
              onChange={(e) => onSearchChange(e.target.value)}
              // Escape is the way out, and it takes the query with it: leaving
              // a filter behind an input that has closed would hide rows with
              // nothing on screen saying why.
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                closeSearch();
              }}
              // Only where there is nothing to lose. Clicking away from a query
              // that is narrowing the list is not a request to drop it.
              onBlur={() => {
                if (!search) setSearching(false);
              }}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSearching(true)}
            className="w-full justify-start px-1.5 text-ui"
          >
            <Search />
            Search
          </Button>
        )}
      </div>

      {/* The filter is where project grouping went. */}
      <div className="mt-4 flex items-start justify-between py-1 pr-2 pl-3">
        <ProjectFilter
          projects={projects}
          value={projectFilter}
          onChange={onProjectFilterChange}
        />

        <div className="flex items-center gap-0.5">
          {/* The icon names the destination, not the current view: `CheckCheck`
              (the row control's single `Check`, doubled — every settled one) goes
              to the settled list, `Inbox` comes back. A pressed state on one icon
              can't say that on its own, so the glyph swaps instead. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={showArchived ? "Show active" : "Show settled"}
                onClick={onToggleArchived}
                className="text-muted-foreground hover:text-foreground"
              >
                {showArchived ? <Inbox /> : <CheckCheck />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {showArchived ? "Show active" : "Show settled"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* No right padding: the scrollbar gutter is the right-hand spacing. The
          rows balance the track's extra width themselves with `pr-0.5`. */}
      <div className="scrollbar-overlay flex min-h-0 flex-1 flex-col gap-px overflow-y-auto pb-3 pl-2 pr-0">
        {rowCount === 0 ? (
          <p className="px-2 py-6 text-ui text-muted-foreground">{emptyText}</p>
        ) : (
          groups.map((group, index) => {
            // A project heading is drawn only where the list spans projects:
            // under a filter the label above already names the one project
            // every row belongs to, and a heading repeating it would be a
            // second copy of the same fact. Pinned is never dropped — it names
            // a set the reader made themselves, which nothing else on screen
            // says. Word only, no icon and no count, like the project headings
            // it sits above.
            const heading =
              group.kind === "pinned"
                ? "Pinned"
                : projectFilter === null
                  ? projectName(group.projectPath)
                  : null;

            return (
              <Fragment key={group.kind === "pinned" ? "pinned" : group.projectPath}>
                {heading !== null ? (
                  <div
                    // Full path on hover, since two projects can share a folder
                    // name. Pinned has no one path to name.
                    title={group.kind === "project" ? group.projectPath : undefined}
                    className={cn(
                      "flex min-h-6 items-center truncate pr-2 pl-2 text-ui text-muted-foreground/70",
                      // The first heading sits under the filter's own row, which
                      // already carries the gap; the rest open a run and need it.
                      index > 0 && "mt-3",
                    )}
                  >
                    {heading}
                  </div>
                ) : (
                  // A run drawing no heading of its own still needs the break
                  // one would have carried. Under a project filter the Pinned
                  // group is followed by that same project's remaining rows,
                  // and with nothing between them the whole list reads as
                  // sitting under the Pinned heading.
                  index > 0 && <div aria-hidden className="h-3" />
                )}

                {group.rows.map(({ item, depth, guides, opens }) => (
                  <SessionRow
                    key={item.sessionId}
                    item={item}
                    depth={depth}
                    guides={guides}
                    opens={opens}
                    status={statusBySession[item.sessionId] ?? item.status}
                    asking={askingSessions.has(item.sessionId)}
                    pr={prFor(item.projectPath, sessionBranch(item))}
                    active={item.sessionId === selectedSessionId}
                    // The settled list is a history, and the question asked of it is
                    // "what did I finish today" — so everything older is held back
                    // rather than filtered out. Only there: the active list is a
                    // worklist, where an older row is still open work.
                    faded={showArchived && !isToday(item.modified)}
                    // Nothing refreshes marks over here: the archived view asks for
                    // no repos, so its rows draw from a cache nothing will update.
                    // A stale glyph is the accepted trade; a stale *spinner* is not,
                    // since it animates a claim that something is happening now.
                    marksLive={!showArchived}
                    nested={isNested(item, items)}
                    // A row drawn under Pinned below the top is there because
                    // its parent is — `splitPinned` only carries a nest whole.
                    // Unless it holds a pin of its own as well: that flag is
                    // real and outlives the ancestor's, so hiding the action
                    // there would strand it, and the row would come back pinned
                    // for no reason the reader could see once the ancestor was
                    // unpinned.
                    inheritsPin={
                      group.kind === "pinned" && depth > 0 && !item.pinned
                    }
                    onSelect={onSelect}
                    onSetFlags={onSetFlags}
                    onFork={onFork}
                    onDelete={onDelete}
                    onDetach={onDetach}
                  />
                ))}
              </Fragment>
            );
          })
        )}

        {/* Sits in the list as its last row, so it scrolls away once there are
            enough sessions to push it off — by then the shortcut has been read.
            Pinning it to the sidebar's bottom edge would keep it on screen
            forever, which is a permanent line of chrome for a one-time hint.
            Hidden with only one row: there's nothing to jump or switch to. */}
        {rowCount > 1 && <ShortcutHint selected={selectedSessionId !== null} />}
      </div>

      {/* Outside the scroll container, unlike the shortcut hint above it: that
          is a one-time tip that has earned its way off screen, and this is an
          offer that has to still be there when the list is long. */}
      <UpdateRow
        status={updateStatus}
        blocked={updateBlocked}
        manual={updateManual}
        onInstall={onInstallUpdate}
      />

      {/* Under the update row, and last in the column: both are standing
          information, and this is the half nobody is waiting on. */}
      {import.meta.env.DEV && <DevBadge />}
    </aside>
  );
}

/// The ⌘⇧↑/↓ hint, laid out on the session rows' own edges so it reads as the
/// last row rather than as a caption under the list.
///
/// With nothing selected both arrows land on the same place — the newest session
/// — so showing the pair would offer a choice that isn't one. One arrow, and the
/// verb changes with it: entering the list is a jump, walking it is a switch.
function ShortcutHint({ selected }: { selected: boolean }) {
  return (
    <div className="flex min-h-7 items-center justify-between pr-0.5 pl-2 text-ui text-muted-foreground/60">
      {selected ? "Switch tasks" : "Jump to task"}
      {/* Held back from the stock keycap: everywhere else a `Kbd` labels a
          control the eye is already on, but this one is the row, so the default
          fill makes a hint the loudest thing in the list. */}
      <KbdGroup className="[&_kbd]:bg-muted/40 [&_kbd]:text-muted-foreground/60">
        <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
        {/* Spelled out on every platform, unlike the ⌘ beside it. ⇧ is the one
            modifier glyph that doesn't read as itself — an arrow, in a hint
            that ends in arrow keys — so no keycap in the app draws it. */}
        <Kbd>Shift</Kbd>
        <Kbd>{selected ? "↑↓" : "↓"}</Kbd>
      </KbdGroup>
    </div>
  );
}

/// From this many projects a tap opens a menu instead of stepping one. Tapping
/// through a long list is a scrub rather than a pick, and the dots stop being
/// countable.
const PROJECT_MENU_FROM = 5;

// Dot geometry, in px, kept here because the track's offset is computed from it
// rather than measured: `size-1` plus `gap-1`.
const DOT = 4;
const DOT_GAP = 4;
const DOT_PITCH = DOT + DOT_GAP;
// Five slots. Odd, so there is a real middle for the active dot to sit in.
const DOT_TRACK_W = DOT_PITCH * 5 - DOT_GAP;

// How far a swipe must travel before it counts as one. Momentum keeps firing
// `wheel` long after the fingers lift, so a gesture ends on one of two signs
// that the push is over: a stretch of quiet, or deltas decayed to the tail.
// Quiet alone was not enough — the tail can outlast a second deliberate swipe,
// which is what made every other swipe do nothing.
const SWIPE_PX = 36;
const SWIPE_END_MS = 120;
const SWIPE_TAIL = 2;

/// The project filter. The label names the current scope and the dots under it
/// are the map: one per entry, **the active one always in the middle**, so the
/// row slides under a fixed centre rather than a marker travelling along a fixed
/// row. That is what keeps the indicator readable once there are more projects
/// than dots that fit.
///
/// Switching is a two-finger swipe or a tap, both anywhere over the band. Swipe
/// means the same thing in both modes — the menu is what a *tap* becomes once
/// there are enough projects to pick from, not a replacement for the gesture.
function ProjectFilter({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string | null;
  onChange: (path: string | null) => void;
}) {
  // "All" is an entry rather than a special case, so the swipe, the dots and
  // the menu all walk one list and can't disagree about what's next.
  const entries = useMemo(
    () => [
      { path: null as string | null, name: "All Projects" },
      ...projects.map((p) => ({ path: p.path as string | null, name: p.name })),
    ],
    [projects],
  );

  // A detached project leaves its path behind in the stored filter. Falling back
  // to All is the only honest answer, and the dot track needs a real index.
  const found = entries.findIndex((e) => e.path === value);
  const activeIndex = found === -1 ? 0 : found;
  const active = entries[activeIndex];

  const ref = useRef<HTMLDivElement>(null);
  const travel = useRef(0);
  const armed = useRef(true);
  const idle = useRef<number | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const endGesture = () => {
      travel.current = 0;
      armed.current = true;
    };

    const onWheel = (e: WheelEvent) => {
      // Vertical wins. The session list scrolls right below this, and a swipe
      // that is mostly down must not be read as a sideways one.
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      // Claimed so the webview can't read it as an overscroll gesture. Bound
      // natively because React's own wheel listener is passive, where
      // `preventDefault` is a no-op.
      e.preventDefault();

      window.clearTimeout(idle.current);
      idle.current = window.setTimeout(endGesture, SWIPE_END_MS);

      // One step per gesture: momentum alone is enough to cross the threshold
      // several more times, which would fling the filter past what was aimed at.
      if (!armed.current) {
        if (Math.abs(e.deltaX) <= SWIPE_TAIL) endGesture();
        return;
      }

      // A reversal starts the count over rather than subtracting from it. A
      // swipe is rarely one clean direction, and letting the two cancel is what
      // made a real push sometimes add up to nothing.
      if (Math.sign(e.deltaX) !== Math.sign(travel.current)) travel.current = 0;
      travel.current += e.deltaX;
      if (Math.abs(travel.current) < SWIPE_PX) return;

      const next = activeIndex + Math.sign(travel.current);
      armed.current = false;
      travel.current = 0;
      // Clamped, not wrapped — the track is a line, and jumping it end to end
      // would read as the dots losing their place.
      if (next >= 0 && next < entries.length) onChange(entries[next].path);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [activeIndex, entries, onChange]);

  useEffect(() => () => window.clearTimeout(idle.current), []);

  const menuMode = projects.length >= PROJECT_MENU_FROM;

  // Wraps, since a tap has no direction and no dot to slide — a dead end at the
  // last entry would just look broken.
  const cycle = () => onChange(entries[(activeIndex + 1) % entries.length].path);

  // The band is the control, not the label: the swipe only fires where the
  // cursor is, and aiming at 20 characters of text to start a gesture is what
  // read as the swipe working only sometimes. Tap answers on the same surface,
  // so both gestures have the same target. Nothing inside is a button — one
  // click target, so there is no inner element to swallow a tap or fire twice.
  const band = (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      // In menu mode the trigger's own handlers arrive through `asChild`.
      onClick={menuMode ? undefined : cycle}
      onKeyDown={
        menuMode
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                cycle();
              }
            }
      }
      // The negative margin gives the band height without moving anything:
      // `items-center` keeps the column itself where it was. No focus ring: the
      // band is a strip of empty space, so a box drawn around it reads as a
      // stray frame rather than as the label being focused.
      className="group/projects -my-1 flex min-w-0 flex-1 cursor-pointer flex-col items-start py-1 pl-1 focus-visible:outline-none"
    >
      {/* Hugs its own contents, so the dots stay centred under the label rather
          than under the band. */}
      <div className="flex max-w-full flex-col items-center gap-1">
        {/* Lit from the band's hover rather than its own, so reaching anywhere
            on the strip says the strip is what answers. */}
        <span className="flex items-center gap-1 text-ui text-muted-foreground transition-colors group-hover/projects:text-foreground">
          <span className="max-w-40 truncate">{active.name}</span>
          {/* The one mark that says a tap opens a list rather than stepping one.
              Menu mode is otherwise invisible — same label, same dots. */}
          {menuMode && <ChevronDown className="size-3 shrink-0 opacity-60" />}
        </span>

        {/* Reserved height, so revealing the dots never shifts the list below.
            One entry is the whole story already — a lone dot would offer a
            gesture that can't go anywhere. */}
        <div className="h-1.5">
          {entries.length > 1 && (
            <div
              className="flex h-full items-center overflow-hidden opacity-0 transition-opacity duration-150 group-hover/projects:opacity-100"
              style={{
                width: DOT_TRACK_W,
                // Faded at both ends, so a dot leaving the track reads as
                // sliding out rather than as being cut off.
                maskImage:
                  "linear-gradient(to right, transparent, black 30%, black 70%, transparent)",
              }}
            >
              <div
                className="flex items-center transition-transform duration-200 ease-out"
                style={{
                  gap: DOT_GAP,
                  // Puts the active dot's centre on the track's centre.
                  transform: `translateX(${DOT_TRACK_W / 2 - DOT / 2 - activeIndex * DOT_PITCH}px)`,
                }}
              >
                {entries.map((entry, i) => (
                  <span
                    key={entry.path ?? ""}
                    className={cn(
                      "size-1 shrink-0 rounded-full transition-colors",
                      i === activeIndex
                        ? "bg-foreground/80"
                        : "bg-muted-foreground/30",
                    )}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (!menuMode) return band;

  // The band is the trigger, so a tap anywhere on it opens the list — the same
  // surface the swipe answers on, rather than a second smaller one on the label.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{band}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuRadioGroup
          // Radix radio values are strings, so All rides on the empty one — no
          // path is ever empty, so the two can't collide.
          value={value ?? ""}
          onValueChange={(next) => onChange(next === "" ? null : next)}
        >
          {entries.map((entry) => (
            // Two projects can share a folder name, so the full path is the
            // tooltip rather than the label.
            <DropdownMenuRadioItem
              key={entry.path ?? ""}
              value={entry.path ?? ""}
              title={entry.path ?? undefined}
              className="text-ui"
            >
              <span className="truncate">{entry.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// One hover control on a session row. Stops the click from reaching the row's
/// own handler, so acting on a session never also selects it.
function RowAction({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-pressed={active}
          onClick={(e) => {
            e.stopPropagation();
            onClick(e);
          }}
          // Set here rather than inherited from the row: the UA stylesheet's own
          // `button { cursor: default }` wins over an inherited value.
          className={cn(
            "cursor-pointer",
            active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/// The fork submenu's rows, in the order they are drawn. The number key that
/// picks one is its position here — same rule `VIEW_TABS` accelerators follow —
/// so reordering moves the digits with it and there is no second table to fall
/// out of step with the labels.
const FORKS = [
  { label: "Fork here", worktree: false },
  { label: "Fork in new worktree", worktree: true },
] as const;

/// The row's right-click menu. Delete confirms in place — a second surface for
/// two words costs more than it protects, and the menu is already open under the
/// cursor. Both steps live in one `Content` so the menu holds its position
/// across the swap; reanchoring mid-decision would move the target being aimed
/// at.
///
/// `confirming` resets on open rather than on close. The content unmounts either
/// way, but the state lives out here, so without it a cancelled delete would
/// reopen already armed.
///
/// A context menu can't be opened programmatically, so `ContextMenu` takes no
/// `open` — the trigger's own `data-state` is what the row styles off, and there
/// is no second copy of the flag to fall out of step with it.
function RowMenu({
  onFork,
  forkDisabled,
  onDelete,
  onDetach,
  children,
}: {
  onFork: (worktree: boolean) => void;
  /// The session is working. The CLI forks by reading its transcript, which a
  /// live child is still appending to, so a fork taken now can inherit half a
  /// turn. The backend refuses it too — this only saves the trip.
  forkDisabled: boolean;
  onDelete: () => void;
  /// Absent on a row that isn't nested — there is nothing to detach from, and
  /// a disabled item on every row in the list would be noise rather than a
  /// promise of something coming.
  onDetach?: () => void;
  children: React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  // Radix moves DOM focus onto the sub's own content only once the pointer (or
  // an arrow key) actually enters it — hovering the trigger alone opens the
  // submenu but leaves focus behind on the trigger. Reading `open` instead of
  // focus location is what lets a number fire the moment the submenu is drawn,
  // without the cursor ever crossing into it.
  const [forkOpen, setForkOpen] = useState(false);
  // A digit clicks the row rather than calling `onFork` directly, so closing the
  // menu and restoring focus stay Radix's job — picking by key and picking by
  // mouse then cannot end in different states.
  const forkRefs = useRef<(HTMLDivElement | null)[]>([]);

  return (
    <ContextMenu onOpenChange={(open) => open && setConfirming(false)}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>

      {/* Portaled, so a click in here never reaches the row's select handler. */}
      {/* Wide enough for the confirm step's two buttons, which is the widest
          thing this menu ever holds — the width is fixed rather than fitted so
          the frame doesn't resize under the cursor when Delete swaps them in. */}
      {/*
          The digit listener lives up here rather than on the sub's own content:
          `SubContent` renders through a portal, so a handler placed there only
          ever fires once focus — not just the open submenu — has moved inside
          it. React still delivers the event here through the component tree
          rather than the DOM one, so this fires the instant the submenu opens,
          whether that happened by hover or by keyboard, and no matter which of
          the two elements the key lands on.
      */}
      <ContextMenuContent
        className="w-48"
        onKeyDown={(e) => {
          if (!forkOpen) return;
          const picked = forkRefs.current[Number(e.key) - 1];
          if (!picked) return;
          // Holds the digit back from Radix's own typeahead, which would
          // otherwise read it as a search letter and jump focus instead.
          e.preventDefault();
          picked.click();
        }}
      >
        {confirming ? (
          <>
            {/* No title in the copy: the menu opens on the row, which stays on
                screen beside it and already names the session. */}
            <p className="px-1.5 py-1 text-ui text-muted-foreground">
              Are you sure?
            </p>

            {/* Items rather than buttons, so selecting either closes the menu on
                its own — nothing here can reopen it, and a stranded confirm step
                is the one state with no way out but Escape. */}
            <div className="mt-1 flex gap-1">
              <ContextMenuItem className="flex-1 justify-center text-ui">
                Cancel
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onSelect={onDelete}
                className="flex-1 justify-center bg-destructive/10 text-ui"
              >
                Yes, Delete
              </ContextMenuItem>
            </div>
          </>
        ) : (
          <>
            {/* A submenu because the two forks differ in where the copy
                *runs*, not in what it copies — both carry the whole
                conversation. Flattening them into two top-level items would put
                the rarer choice beside Delete on every row. */}
            <ContextMenuSub onOpenChange={setForkOpen}>
              <ContextMenuSubTrigger
                disabled={forkDisabled}
                className="text-ui"
              >
                <GitBranchPlus />
                Fork
              </ContextMenuSubTrigger>

              {/* Sized by its own rows. Nothing swaps in here, so there is
                  no second layout to hold a width for. */}
              <ContextMenuSubContent>
                {FORKS.map((fork, i) => (
                  <ContextMenuItem
                    key={fork.label}
                    ref={(el) => {
                      forkRefs.current[i] = el;
                    }}
                    className="text-ui"
                    onSelect={() => onFork(fork.worktree)}
                  >
                    {fork.label}
                    <Kbd className="ml-auto">{i + 1}</Kbd>
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>

            {onDetach && (
              <ContextMenuItem className="text-ui" onSelect={onDetach}>
                <Unlink />
                Detach from parent
              </ContextMenuItem>
            )}

            {/* `preventDefault` holds the menu open — an item select closes it by
                default, which would take the confirm step down with it. */}
            <ContextMenuItem
              variant="destructive"
              className="text-ui"
              onSelect={(e) => {
                e.preventDefault();
                setConfirming(true);
              }}
            >
              <Trash2 />
              Delete
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/// Connector geometry, in px from the row's left edge. `RAIL_X` sits just
/// inside the unread rail's own 8px slot, `STEP` is one level of nesting, and
/// `ELBOW` is how far the horizontal reaches before the title starts.
const RAIL_X = 12;
const STEP = 12;
const ELBOW = 10;

function SessionRow({
  item,
  depth,
  guides,
  opens,
  status,
  asking,
  pr,
  active,
  faded = false,
  marksLive = true,
  onSelect,
  nested = false,
  inheritsPin = false,
  onSetFlags,
  onFork,
  onDelete,
  onDetach,
}: {
  item: SessionIndexItem;
  /// Levels below the top; 0 draws no connector at all. See [`sessionRows`] —
  /// these three come out of the same walk that ordered the list.
  depth: number;
  guides: boolean[];
  opens: boolean;
  status: SessionStatus;
  asking: boolean;
  /// The pull request this row is marked with, already narrowed to one where
  /// the branch carries several. Undefined covers both "no PR" and "we couldn't
  /// ask" — the mark is decoration, so the two read the same.
  pr?: PrMark;
  active: boolean;
  faded?: boolean;
  /// Something is still refreshing this row's mark. False in the archived view,
  /// which asks for no repos — see the call site.
  marksLive?: boolean;
  onSelect: (sessionId: string) => void;
  /// This row has a parent in the same list, so 'Detach from parent' is a real
  /// offer. Kept apart from `depth` only because a cyclic index draws a row at
  /// the top level that still has a link worth cutting.
  nested?: boolean;
  /// This row is in the Pinned group through an ancestor *and* carries no pin
  /// of its own. Pinning it would then decide nothing on screen — the row stays
  /// where it is either way — so the action is dropped rather than left
  /// offering a verb that moves nothing and leaves a flag behind. A row holding
  /// its own pin keeps the action whatever its ancestor does: that flag is the
  /// one thing there the reader can still be surprised by later.
  inheritsPin?: boolean;
  onSetFlags: (
    sessionId: string,
    flags: { archived?: boolean; pinned?: boolean },
  ) => Promise<void>;
  onFork: (sessionId: string, worktree: boolean) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
  onDetach: (sessionId: string) => Promise<void>;
}) {
  // The keyboard shortcut can walk the selection past the fold, and `nearest`
  // means a row selected by click — already in view — doesn't scroll at all.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // The rail this row elbows onto is its parent's, one step to the left of the
  // one it opens for its own children.
  const ownRail = RAIL_X + (depth - 1) * STEP;
  const parentCarriesOn = guides[depth - 1] ?? false;

  return (
    <RowMenu
      onFork={(worktree) => void onFork(item.sessionId, worktree)}
      forkDisabled={status === "in_progress"}
      onDelete={() => void onDelete(item.sessionId)}
      onDetach={nested ? () => void onDetach(item.sessionId) : undefined}
    >
      {/* A button can't nest a button, so the row is a div with a click handler
          and the pin/settle controls are the only real buttons inside it. */}
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        onClick={() => void onSelect(item.sessionId)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void onSelect(item.sessionId);
          }
        }}
        className={cn(
          // No vertical padding: the 24px hover buttons are the tallest thing in
          // the row, so they'd add to any padding here and make the row grow the
          // moment these controls landed. `min-h` keeps the height when they're
          // the only thing not rendered — an empty row still matches a populated
          // one.
          // No left padding and no `gap`: the unread rail's own 8px slot is the
          // indent that padding used to provide, so the title sits exactly where
          // it always did and the rail can still touch the row's edge. The one
          // gap that remains — title to hover controls — is `pl-2` on that slot.
          "group relative flex min-h-7 w-full cursor-pointer items-center rounded-md pl-0 pr-0.5",
          // Opacity is in the transition list for the faded rows below. It has
          // to ride the same declaration: `transition-colors` and
          // `transition-opacity` both set `transition-property`, so `cn` would
          // merge one away and the row would lose its hover fill animation.
          "transition-[color,background-color,opacity]",
          // Held back rather than hidden, and brought back to full strength the
          // moment the row is reached for — the fade sorts the list at a glance
          // and must not make an old row harder to read once it's the one being
          // used.
          faded &&
            !active &&
            "opacity-50 hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          // `data-state` is the trigger's, set on this element by
          // `ContextMenuTrigger asChild` — an open menu holds the row lit, since
          // the cursor is over the menu rather than the row it belongs to. In the
          // inactive branch only: the selected row's fill is already stronger.
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 data-[state=open]:bg-sidebar-accent/50",
        )}
      >
        {/* Two things put a mark here, and both are the reader's to clear: the
            session finished and hasn't been read, or it has stopped and is
            waiting on an answer. Working is shown on the right instead, in place
            of the timestamp — this rail is the "over to you" mark alone, so it
            keeps the left edge it can be scanned down.

            Waiting wins where both could apply, and it is the command yellow
            against the finished green: one is news that will keep, the other is
            an agent standing still until it is dealt with. `--accent-command`
            rather than a fresh amber, so the app keeps to one yellow — it
            already means "this is for you" wherever a slash command is drawn.

            The slot is always here and the rail inside it is what comes and
            goes: a mark that reflows the title would shift the text of a row
            just because its agent finished. A fixed height rather than the row's
            own, so the rail reads the same length whatever the row grows to. */}
        <span className="flex w-2 shrink-0 items-center self-stretch">
          {(asking || status === "completed") && (
            <span
              role="img"
              aria-label={asking ? "Waiting for you" : "Unread"}
              className={cn(
                "h-3 w-0.5 rounded-[1px]",
                asking ? "bg-accent-command" : "bg-emerald-500",
              )}
            />
          )}
        </span>

        {/* The lineage, drawn as rails: this row elbows onto its parent's, and
            an ancestor's carries straight through to the last row of its
            subtree. Aria-hidden and never a target — it is a picture of the
            list's own shape, and a screen reader reads the rows in the order
            they are drawn anyway.

            Every piece sits on its own pixel and no two overlap.
            `--sidebar-border` is white at 8%, so two segments sharing a column
            stack to ~15% and read as a bright patch halfway down the rail. */}

        {/* One pass-through per ancestor above this row's own parent whose line
            is still open, each on its own column. */}
        {guides.slice(0, -1).map(
          (open, level) =>
            open && (
              <span
                key={level}
                aria-hidden
                className="pointer-events-none absolute top-0 -bottom-px w-px bg-sidebar-border"
                style={{ left: RAIL_X + level * STEP }}
              />
            ),
        )}

        {depth > 0 && (
          <>
            {/* Stops at the elbow unless the parent's rail carries on below —
                never a full-height line with the corner drawn over half of it.
                Rows sit in a `gap-px` column, so a piece that carries on has to
                reach 1px past its own bottom edge or the rail reads dashed. */}
            <span
              aria-hidden
              className="pointer-events-none absolute top-0 w-px bg-sidebar-border"
              style={{
                left: ownRail,
                height: parentCarriesOn ? "calc(100% + 1px)" : "50%",
              }}
            />
            {/* Square corner, started one pixel clear of the vertical's own
                column. */}
            <span
              aria-hidden
              className="pointer-events-none absolute h-px bg-sidebar-border"
              style={{ left: ownRail + 1, top: "50%", width: ELBOW - 5 }}
            />
          </>
        )}

        {/* The rail this row opens for the rows under it, from its own centre
            down. Without it a parent's line would start a row late. */}
        {opens && (
          <span
            aria-hidden
            className="pointer-events-none absolute -bottom-px w-px bg-sidebar-border"
            style={{ left: RAIL_X + depth * STEP, top: "50%" }}
          />
        )}

        {/* A fixed slot rather than padding, so every row at a level starts its
            title on the same column whatever else the row is carrying. */}
        {depth > 0 && (
          <span aria-hidden className="shrink-0" style={{ width: ownRail + ELBOW - 8 }} />
        )}

        {/* Ahead of the title, and it takes no room when there is none — unlike
            the rail beside it, which holds its slot. The two differ because the
            rail comes and goes on the *same* row as its agent works, where a
            branch either has a pull request or does not: a row that never gets
            one would otherwise pay for the mark forever, and most never do.

            The rail keeps the outer edge because it is the "over to you" mark
            and clears when the reader deals with it, where this is a standing
            fact about the branch.

            Glyph and colour are [PrStateIcon]'s, shared with the panel's own
            header — the mark and the thing it points at have to match, and two
            copies of that table drift on exactly the state nobody was looking
            at. Emerald open, muted draft, purple merged, and red wherever CI
            has failed on one still open.

            Merged earns a mark for a different reason than the other two do.
            They say "this branch has somewhere to land"; it says the work
            landed, so the row is one to archive — which is the question asked
            of this list at the end of a day, and until now had to be answered
            by opening every session in turn.

            `title` rather than a tooltip: this is a decoration on a row that is
            itself a control, and a tooltip on it would open every time the
            cursor crossed the list. Number first and the state after it, since
            the state is a clause now that a failure can extend it. */}
        {pr && (
          <span
            className="mr-1 flex shrink-0 items-center"
            title={`Pull request #${pr.number} · ${prStateLabel(pr).toLowerCase()}`}
          >
            <PrStateIcon pr={pr} strokeWidth={1.5} />
          </span>
        )}

        <span className="min-w-0 flex-1 truncate text-ui">{item.title}</span>

        {/* One slot for both, sized by the buttons and always holding that width
            — so a long title truncates against it either way and nothing reflows
            on hover. The two children stack via `absolute` on the date and
            crossfade on `opacity` over the same duration, so they never both
            read at once; `visibility` would flip instantly while the button's
            inherited `transition-all` still crossfades, which is what read as an
            overlap. */}
        <div className="relative flex shrink-0 items-center justify-end self-stretch pl-2">
          {/* `pointer-events-none` unconditionally: it's never a target, and a
              faded-but-present element still hit-tests — stacked on `right-0` it
              would otherwise swallow the cursor over the last button, which reads
              as that one button being dead while its neighbour works. */}
          <span className="pointer-events-none absolute right-0 flex items-center text-ui text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-data-[state=open]:opacity-0">
            {/* The orb takes the timestamp's place rather than a slot of its
                own: a row that's working right now is the one row whose "last
                activity" reads as stale, and one indicator per row is what keeps
                the right edge quiet. 20 is the inline-with-text preset, and
                `theme` is pinned for the same reason as everywhere else — the
                orb's `auto` looks for `data-theme="dark|light"` and this app
                stamps a palette name there. */}
            {/* Three things want this one slot, and the order is the whole of
                the rule. Checks win: the orb says the agent is working, which
                the reader already knows because they set it going and the
                transcript is one click away — where CI reports on a machine
                elsewhere, on its own schedule, and this row is the only place
                that lands. The orb comes next, for the same reason it beats the
                timestamp: "last activity" is the least useful thing to say
                about a row with anything in flight.

                Same dashed spinner and same command yellow the PR panel's own
                pending check row uses, at the same 3s turn: one glyph for one
                fact, so a reader who has seen it in the pane knows it here. It
                is deliberately not a *verdict* — a check that passed or failed
                is settled, and the row goes back to its timestamp rather than
                growing a second colour to decode.

                `mr-[3px]` sits it on the orb's centre line: the glyph is 14px
                against the orb's 20px box, and both are flush right, so without
                it the mark shifts sideways row to row. */}
            {marksLive && pr?.checksState === "RUNNING" ? (
              <CircleDashed
                className="mr-[3px] size-3.5 animate-spin text-accent-command [animation-duration:3s]"
                strokeWidth={1.5}
                aria-label="Checks running"
              />
            ) : status === "in_progress" ? (
              <ThinkingOrb
                state="listening"
                size={20}
                theme="dark"
                aria-label="Working"
              />
            ) : (
              relativeTime(item.modified)
            )}
          </span>

          {/* `opacity-0` rather than `hidden`: shadcn's button base sets
              `inline-flex`, and Tailwind emits that after `hidden` at equal
              specificity, so a `display` utility here silently loses.
              `pointer-events-none` keeps the invisible buttons unclickable. */}
          <div className="pointer-events-none relative flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-data-[state=open]:pointer-events-auto group-data-[state=open]:opacity-100">
            {/* Absent on a row that follows a pinned ancestor rather than
                carrying the pin itself, the way 'Detach from parent' is absent
                where there is no parent drawn: the row sits in the Pinned group
                whichever way its own flag reads, so both verbs would move
                nothing — and Pin would quietly leave a flag behind to surprise
                the reader once the ancestor is unpinned. */}
            {!inheritsPin && (
              <RowAction
                label={item.pinned ? "Unpin" : "Pin"}
                active={item.pinned}
                onClick={() => onSetFlags(item.sessionId, { pinned: !item.pinned })}
              >
                <Pin />
              </RowAction>
            )}

            <RowAction
              label={item.archived ? "Unsettle" : "Settle"}
              active={item.archived}
              onClick={(e) => {
                // Fired on the click, not after the write lands: the burst is
                // the button's own answer, and the row is gone from this list a
                // frame later. The celebration sound stays with the write in
                // `App`, where the flag is confirmed.
                if (!item.archived) burstConfetti(e.currentTarget);
                onSetFlags(item.sessionId, { archived: !item.archived });
              }}
            >
              {/* Settle reads as "check this off"; unsettle isn't a second
                  checkmark, it's undoing the first one. */}
              {item.archived ? <Undo2 /> : <Check />}
            </RowAction>
          </div>
        </div>
      </div>
    </RowMenu>
  );
}
