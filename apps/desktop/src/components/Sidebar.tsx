import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  ChevronDown,
  CircleDashed,
  GitBranchPlus,
  Inbox,
  // Pin,
  Plus,
  Search,
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
  // Already scoped to `projectFilter` by the caller, so the list and the ⌘⇧↑/↓
  // walk step through exactly the same rows.
  items: SessionIndexItem[];
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
  onSelect: (sessionId: string) => Promise<void>;
  onNewSession: () => void;
  onSetFlags: (
    sessionId: string,
    flags: { archived?: boolean; pinned?: boolean },
  ) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
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

/// The order the list is drawn in. Exported because the ⌘⇧↑/↓ shortcut steps
/// through the same sequence, and a second comparator would let the two disagree
/// about which row is "next" — worse when the sidebar is collapsed and nothing
/// on screen shows the order being walked.
export function sortSessions(items: SessionIndexItem[]): SessionIndexItem[] {
  return [...items].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
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

/// Marks a dev build so it can't be mistaken for the installed app. Gated on
/// `import.meta.env.DEV`, which Vite folds to a constant — the badge and this
/// component are dropped from a production bundle entirely.
export function DevBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "rounded bg-orange-500/15 px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium tracking-wide text-orange-500 uppercase",
        className,
      )}
    >
      Dev
    </span>
  );
}

export default function Sidebar({
  items,
  statusBySession,
  askingSessions,
  prFor,
  selectedSessionId,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onNewSession,
  onSetFlags,
  onDelete,
  showArchived,
  onToggleArchived,
  projects,
  projectFilter,
  onProjectFilterChange,
  updateStatus,
  updateBlocked,
  updateManual,
  onInstallUpdate,
}: SidebarProps) {
  const fullscreen = useFullscreen();

  // Flat and recency-ordered. Project only survives as the filter above the
  // list, so the same session never appears under two headings.
  const sorted = useMemo(() => sortSessions(items), [items]);

  // A filtered list that comes up empty is a different fact from an empty app,
  // and saying "No tasks yet" over a filter reads as data loss.
  const emptyText = projectFilter
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
        {import.meta.env.DEV && <DevBadge className="mr-auto" />}
        <SidebarToggle onToggle={onToggleCollapsed} />
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

        <Button
          variant="ghost"
          size="sm"
          disabled
          className="w-full justify-start px-1.5 text-ui"
        >
          <Search />
          Search
        </Button>
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
        {sorted.length === 0 ? (
          <p className="px-2 py-6 text-ui text-muted-foreground">{emptyText}</p>
        ) : (
          sorted.map((item) => (
            <SessionRow
              key={item.sessionId}
              item={item}
              status={statusBySession[item.sessionId] ?? item.status}
              asking={askingSessions.has(item.sessionId)}
              pr={prFor(item.projectPath, sessionBranch(item))}
              active={item.sessionId === selectedSessionId}
              // The settled list is a history, and the question asked of it is
              // "what did I finish today" — so everything older is held back
              // rather than filtered out. Only there: the active list is a
              // worklist, where an older row is still open work.
              faded={showArchived && !isToday(item.modified)}
              onSelect={onSelect}
              onSetFlags={onSetFlags}
              onDelete={onDelete}
            />
          ))
        )}

        {/* Sits in the list as its last row, so it scrolls away once there are
            enough sessions to push it off — by then the shortcut has been read.
            Pinning it to the sidebar's bottom edge would keep it on screen
            forever, which is a permanent line of chrome for a one-time hint.
            Hidden with only one row: there's nothing to jump or switch to. */}
        {sorted.length > 1 && <ShortcutHint selected={selectedSessionId !== null} />}
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
  onDelete,
  children,
}: {
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <ContextMenu onOpenChange={(open) => open && setConfirming(false)}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>

      {/* Portaled, so a click in here never reaches the row's select handler. */}
      <ContextMenuContent className="w-56">
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
            {/* Inert until forking exists. Disabled rather than absent, so the
                menu's shape doesn't change when it lands. */}
            <ContextMenuItem disabled className="text-ui">
              <GitBranchPlus />
              Fork
            </ContextMenuItem>

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

function SessionRow({
  item,
  status,
  asking,
  pr,
  active,
  faded = false,
  onSelect,
  onSetFlags,
  onDelete,
}: {
  item: SessionIndexItem;
  status: SessionStatus;
  asking: boolean;
  /// The pull request this row is marked with, already narrowed to one where
  /// the branch carries several. Undefined covers both "no PR" and "we couldn't
  /// ask" — the mark is decoration, so the two read the same.
  pr?: PrMark;
  active: boolean;
  faded?: boolean;
  onSelect: (sessionId: string) => Promise<void>;
  onSetFlags: (
    sessionId: string,
    flags: { archived?: boolean; pinned?: boolean },
  ) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
}) {
  // The keyboard shortcut can walk the selection past the fold, and `nearest`
  // means a row selected by click — already in view — doesn't scroll at all.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <RowMenu onDelete={() => void onDelete(item.sessionId)}>
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
                the rule. The agent working wins: it is this app's own session
                doing something now, where CI is a machine elsewhere. Checks
                come next, for the same reason the orb beats the timestamp —
                "last activity" is the least useful thing to say about a row
                that has something in flight.

                Same dashed spinner and same command yellow the PR panel's own
                pending check row uses, at the same 3s turn: one glyph for one
                fact, so a reader who has seen it in the pane knows it here. It
                is deliberately not a *verdict* — a check that passed or failed
                is settled, and the row goes back to its timestamp rather than
                growing a second colour to decode. */}
            {status === "in_progress" ? (
              <ThinkingOrb
                state="listening"
                size={20}
                theme="dark"
                aria-label="Working"
              />
            ) : pr?.checksState === "RUNNING" ? (
              <CircleDashed
                className="size-3.5 animate-spin text-accent-command [animation-duration:3s]"
                strokeWidth={1.5}
                aria-label="Checks running"
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
            {/* Pin hidden for now; the flag and its write path stay live. */}
            {/* <RowAction
              label={item.pinned ? "Unpin" : "Pin"}
              active={item.pinned}
              onClick={() => onSetFlags(item.sessionId, { pinned: !item.pinned })}
            >
              <Pin />
            </RowAction> */}

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
