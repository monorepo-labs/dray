import { useEffect, useRef, useState } from "react";
import { PanelLeft, PanelRight, Search } from "lucide-react";

import FileIcon from "@/components/FileIcon";
import FileTabs from "@/components/files/FileTabs";
import FileTree from "@/components/files/FileTree";
import FileViewer from "@/components/files/FileViewer";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFileSearch } from "@/hooks/useFileSearch";
import { useHotkey } from "@/hooks/useHotkey";
import { readLocalStorage, useLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import {
  activateFile,
  closeFile,
  openInFiles,
  refreshOpenFiles,
  useOpenFiles,
  useOpenFilesWatcher,
} from "@/hooks/useOpenFiles";
import { cn } from "@/lib/utils";

type Side = "left" | "right";

const SIDE_KEY = "ade.filesListSide";
const WIDTH_KEY = "ade.filesListWidth";

/// Left, matching every other list in the app. The switch exists because a
/// reader whose editor puts its tree on the right reads a left one as backwards
/// all day, not because either answer is better.
const DEFAULT_SIDE: Side = "left";

/// The Diff view's `w-72`, so the two views open at the same width.
const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 180;
const MAX_WIDTH = 640;

/// The session's directory as a tree, with the files it opens beside it.
///
/// Read-only, for the reason the repo view states: the conversation next door
/// is where work gets made, so a second place to write it would be a second way
/// to do what the reader is already asking the agent for. Nothing here edits,
/// commits or deletes.
export default function FilesView({
  sessionId,
  cwd,
  active,
  revision,
}: {
  sessionId: string;
  cwd: string;
  /// False while another view is showing. The component stays mounted so its
  /// expanded tree and its open tabs survive, but a hidden view must not keep
  /// relisting the directory on every turn.
  active: boolean;
  revision: string;
}) {
  const { open, active: activePath } = useOpenFiles(sessionId);
  useOpenFilesWatcher(sessionId);

  const [side, setSide] = useLocalStorage<Side>(SIDE_KEY, DEFAULT_SIDE);
  // Read once and written on pointerup rather than held in `useLocalStorage`:
  // the drag moves this on every frame, and a stored value would put a JSON
  // stringify on each of them for a number only the last frame decides.
  const [width, setWidth] = useState(() => readLocalStorage(WIDTH_KEY, DEFAULT_WIDTH));

  const [query, setQuery] = useState("");
  const filtering = query.trim().length > 0;
  const matches = useFileSearch(cwd, filtering ? query : null);
  const [hit, setHit] = useState(0);

  const file = open.find((it) => it.path === activePath) ?? null;

  // The tree speaks in paths relative to `cwd`; the store speaks in absolute
  // ones, since a chat link can open a file from outside the tree entirely.
  const openRelative = (path: string) => openInFiles(sessionId, `${cwd}/${path}`);
  const selected = activePath?.startsWith(`${cwd}/`)
    ? activePath.slice(cwd.length + 1)
    : null;

  // The agent's writes are why an open file goes stale, and a turn ending is
  // when it has finished making them. The watcher covers everything between.
  useEffect(() => {
    if (active) refreshOpenFiles(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, sessionId]);

  // ⌘⇧← / ⌘⇧→ step the tab strip, the same shape the Diff view's sub-tabs and
  // the Docs panel's chips are stepped with. Clamped rather than wrapped, and
  // given up inside a text field — the filter box is one, and ⌘⇧← selects to
  // the start of a line there.
  const step = (delta: number) => {
    const next = open[open.findIndex((it) => it.path === activePath) + delta];
    if (next) activateFile(sessionId, next.path);
  };
  const chord = { enabled: active, skipInTextField: true };
  useHotkey("subtab.prev", () => step(-1), chord);
  useHotkey("subtab.next", () => step(1), chord);

  const list = (
    <div
      data-files-list
      className={cn(
        "relative flex shrink-0 flex-col",
        side === "left" ? "border-r border-border" : "border-l border-border",
      )}
      style={{ width }}
    >
      <Filter
        query={query}
        onQuery={(next) => {
          setQuery(next);
          setHit(0);
        }}
        matches={matches}
        onPick={(path) => {
          openRelative(path);
          setQuery("");
        }}
        hit={hit}
        onHit={setHit}
        side={side}
        onSide={setSide}
      />

      {filtering && (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {matches.length === 0 ? (
            <p className="px-3 py-6 text-ui text-muted-foreground">No files match.</p>
          ) : (
            matches.map((match, i) => (
              <button
                key={match.path}
                type="button"
                onClick={() => {
                  openRelative(match.path);
                  setQuery("");
                }}
                onMouseEnter={() => setHit(i)}
                title={match.path}
                className={cn(
                  "flex w-full items-center gap-2 py-1 pl-2 pr-2 text-left text-ui",
                  i === hit ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50",
                )}
              >
                <FileIcon path={match.path} />
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="shrink-0 text-sidebar-foreground">{match.name}</span>
                  {match.dir && (
                    <span className="min-w-0 truncate text-muted-foreground">{match.dir}</span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      <FileTree
        cwd={cwd}
        active={active}
        revision={revision}
        selected={selected}
        onOpen={openRelative}
        filtering={filtering}
      />

      <Handle side={side} width={width} onWidth={setWidth} />
    </div>
  );

  return (
    // The top border is what parts this from the titlebar, the same rule the
    // Diff view states: without it the tab strip floats directly under the
    // window's own controls and reads as part of them.
    <div className={cn("flex min-h-0 flex-1 border-t border-border", side === "right" && "flex-row-reverse")}>
      {list}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {open.length > 0 && (
          <FileTabs
            files={open}
            active={activePath}
            onSelect={(path) => activateFile(sessionId, path)}
            onClose={(path) => closeFile(sessionId, path)}
          />
        )}
        <FileViewer cwd={cwd} file={file} />
      </div>
    </div>
  );
}

/// The filter box, and the one button that moves the list to the other side.
///
/// The same list the composer's `@` picker reads, so the index is already built
/// and already watched — and an empty box draws the *tree*, since that is what
/// an empty filter means here rather than a ranked list of everything.
function Filter({
  query,
  onQuery,
  matches,
  onPick,
  hit,
  onHit,
  side,
  onSide,
}: {
  query: string;
  onQuery: (next: string) => void;
  matches: readonly { path: string }[];
  onPick: (path: string) => void;
  hit: number;
  onHit: (next: number) => void;
  side: Side;
  onSide: (next: Side) => void;
}) {
  const other: Side = side === "left" ? "right" : "left";
  const Icon = side === "left" ? PanelRight : PanelLeft;

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              // Back to the tree, and the focus with it — the list this was
              // filtering is about to stop existing.
              const list = e.currentTarget.closest("[data-files-list]");
              onQuery("");
              // Next frame, not now: the tree is `hidden` until this clear
              // commits, and focusing a `display: none` element does nothing
              // at all — silently, which is the whole trap.
              requestAnimationFrame(() =>
                list?.querySelector<HTMLElement>('[role="tree"]')?.focus(),
              );
              return;
            }
            if (!matches.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              return onHit(Math.min(matches.length - 1, hit + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              return onHit(Math.max(0, hit - 1));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              const picked = matches[hit];
              if (picked) onPick(picked.path);
            }
          }}
          placeholder="Filter files"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-muted-foreground"
        />
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Move list to the ${other}`}
            onClick={() => onSide(other)}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Icon className="size-3.5" strokeWidth={1.5} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Move list to the {other}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/// The strip between the list and the pane, dragged to resize.
///
/// The first drag handle in the app, and it stays inside this component until a
/// second surface wants one. `setPointerCapture` is what makes it work over the
/// code pane: without it the pointer leaves this element on the first frame and
/// every move after that is delivered somewhere else.
function Handle({
  side,
  width,
  onWidth,
}: {
  side: Side;
  width: number;
  onWidth: (next: number) => void;
}) {
  const from = useRef<{ x: number; width: number } | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the file list"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        from.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        const start = from.current;
        if (!start) return;
        // The handle is on the list's *inner* edge, so dragging away from the
        // list widens it — which is the opposite direction on each side.
        const moved = side === "left" ? e.clientX - start.x : start.x - e.clientX;
        onWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, start.width + moved)));
      }}
      onPointerUp={() => {
        if (!from.current) return;
        from.current = null;
        // Written once, at the end: the value moved on every frame of the drag
        // and only the last one is a preference.
        writeLocalStorage(WIDTH_KEY, width);
      }}
      onDoubleClick={() => {
        onWidth(DEFAULT_WIDTH);
        writeLocalStorage(WIDTH_KEY, DEFAULT_WIDTH);
      }}
      className={cn(
        "absolute inset-y-0 z-10 w-1 cursor-col-resize hover:bg-border",
        side === "left" ? "-right-0.5" : "-left-0.5",
      )}
    />
  );
}
