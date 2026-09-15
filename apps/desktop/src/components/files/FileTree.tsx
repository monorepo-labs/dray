import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight } from "lucide-react";

import FileIcon from "@/components/FileIcon";
import { expandTo, flattenTree, ROOT } from "@/lib/fileTree";
import { cn } from "@/lib/utils";
import type { DirEntry } from "@/types/events";

/// Every row is indented by its depth, at the width of one chevron.
const INDENT = 12;

/// The session's directory as a tree, one `list_dir` per expanded directory.
///
/// Not virtualised: a repository with thousands of rows expanded at once is the
/// reader's own doing, and the Diff view's list beside it draws the same way.
/// `ponytail:` windowing is the upgrade if a tree that size turns up.
export default function FileTree({
  cwd,
  active,
  revision,
  selected,
  reveal,
  onOpen,
  filtering,
}: {
  cwd: string;
  /// False while another view is showing. The tree stays mounted so its
  /// expanded set survives, but a hidden one must not relist on every turn.
  active: boolean;
  /// Moves at the end of a turn. What relists every expanded directory, so the
  /// tree keeps up with the agent's writes without anything polling.
  revision: string;
  /// The open file, as a path relative to `cwd`, or null where the active tab
  /// is a file from outside the tree.
  selected: string | null;
  /// The open file's `reveal` counter. Bumped every time that path is opened
  /// afresh, which is the only thing that can say "asked again" about a file
  /// that was already open.
  reveal: number;
  onOpen: (path: string) => void;
  /// True while the filter box is drawing its own list instead. The tree stays
  /// mounted underneath, so its reads are held back rather than its state
  /// thrown away.
  filtering: boolean;
}) {
  const [listings, setListings] = useState<Map<string, DirEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Which row the keyboard is on, as a path rather than an index, so a row that
  // stops existing costs a step back to the top rather than leaving a number
  // pointing into somebody else's row.
  const [cursor, setCursor] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const list = useCallback(
    async (dir: string) => {
      const entries = await invoke<DirEntry[]>("list_dir", { cwd, dir }).catch(() => null);
      // A directory that cannot be read keeps whatever it had: a deleted one is
      // about to disappear from its parent's listing anyway, and blanking it
      // would take the rows with it a frame early.
      if (entries) setListings((prev) => new Map(prev).set(dir, entries));
    },
    [cwd],
  );

  // The root on arrival, and every *expanded* directory whenever the turn ends.
  // One `list_dir` each, and only while this view is the one on screen.
  useEffect(() => {
    if (!active) return;
    void list(ROOT);
    for (const dir of expanded) void list(dir);
    // `expanded` is deliberately not a dependency: expanding one directory
    // lists that one directly, and relisting all of them on every expand would
    // be a fan of reads for a row the reader has already been given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, active, revision, list]);

  const rows = flattenTree(listings, expanded);

  const toggle = useCallback(
    (entry: DirEntry) => {
      const open = expanded.has(entry.path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (open) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      // Outside the updater, which React is free to run twice. Cached until the
      // next relist, so collapsing and reopening is instant and only a first
      // expand costs a read.
      if (!open && !listings.has(entry.path)) void list(entry.path);
    },
    [expanded, listings, list],
  );

  /// What a click on a row does, as one stable function.
  ///
  /// Stable is the whole point: every row is `memo`ized against re-rendering on
  /// each of the transcript's deltas, and an inline arrow per row defeats that
  /// by handing every one of them a new prop each time. This changes only when
  /// the reader expands something or a relist lands, which is exactly when the
  /// rows have to be reconciled anyway.
  const activate = useCallback(
    (entry: DirEntry) => {
      setCursor(entry.path);
      if (entry.isDir) toggle(entry);
      else onOpen(entry.path);
    },
    [toggle, onOpen],
  );

  // Opening from a link or the filter box lands on a file the tree may have
  // every directory above it closed for, so the path is walked and each prefix
  // opened and listed.
  const revealTo = useCallback(
    (path: string) => {
      const dirs = expandTo(path);
      setExpanded((prev) => new Set([...prev, ...dirs]));
      for (const dir of dirs) if (!listings.has(dir)) void list(dir);
      setCursor(path);
    },
    [listings, list],
  );

  // The selected file is the one thing outside this component that moves the
  // tree, and it moves once per *opening* rather than once per file.
  //
  // Keyed on the path alone it fired once and never again, so a reader who
  // collapsed a directory above the open file and clicked the same link a
  // second time got the tab activated under a tree still folded over it. The
  // store's own counter is what says "asked again" — the path cannot, since it
  // has not changed.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) return;
    const asked = `${selected}\n${reveal}`;
    if (revealed.current === asked) return;
    revealed.current = asked;
    revealTo(selected);
  }, [selected, reveal, revealTo]);

  // The cursor takes real focus with it, and that is what makes Enter honest:
  // every row is a button, so the browser already activates the focused one —
  // a cursor drawn beside a focus that stayed behind would open whichever row
  // was clicked last. Only where the tree already holds focus, or revealing a
  // file from a chat link would pull the caret out of the composer.
  useEffect(() => {
    const root = box.current;
    if (!root || !cursor || !root.contains(document.activeElement)) return;
    root.querySelector<HTMLElement>(`[data-path="${CSS.escape(cursor)}"]`)?.focus();
  }, [cursor]);

  const at = rows.findIndex((row) => row.entry.path === cursor);

  const step = (delta: number) => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + delta))];
    if (next) setCursor(next.entry.path);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = rows[at];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        return step(at === -1 ? 0 : 1);
      case "ArrowUp":
        e.preventDefault();
        return step(-1);
      case "ArrowRight": {
        if (!row) return;
        e.preventDefault();
        // Expand, or step into an already-open directory. A file has nothing
        // to open, so → there is the step down the row below it would be.
        if (row.entry.isDir && !expanded.has(row.entry.path)) return toggle(row.entry);
        return step(1);
      }
      case "ArrowLeft": {
        if (!row) return;
        e.preventDefault();
        if (row.entry.isDir && expanded.has(row.entry.path)) return toggle(row.entry);
        // Out to the parent, which is the nearest row above at one less depth.
        for (let i = at - 1; i >= 0; i--) {
          if (rows[i].depth < row.depth) return setCursor(rows[i].entry.path);
        }
        return;
      }
      // Enter is deliberately absent: the row under the cursor *is* the focused
      // button, so the browser fires its click already. Handling it here too
      // would toggle a directory open and shut in one press.
    }
  };

  if (rows.length === 0) {
    return (
      <p className={cn("px-3 py-6 text-ui text-muted-foreground", filtering && "hidden")}>
        {listings.has(ROOT) ? "This directory is empty." : "Reading the directory…"}
      </p>
    );
  }

  return (
    // One tab stop for the whole list, with the arrows handled here: a tree is
    // read as one control, and tabbing through a hundred rows to leave it is
    // not a thing to do to anybody.
    <div
      ref={box}
      role="tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
      // Hidden rather than unmounted while the filter list is up: the expanded
      // set is what the reader built, and clearing the box has to give it back.
      className={cn(
        "min-h-0 flex-1 overflow-auto py-1 outline-none",
        filtering && "hidden",
      )}
    >
      {rows.map((row) => (
        <Row
          key={row.entry.path}
          entry={row.entry}
          depth={row.depth}
          expanded={expanded.has(row.entry.path)}
          selected={row.entry.path === selected}
          cursor={row.entry.path === cursor}
          onActivate={activate}
        />
      ))}
    </div>
  );
}

/// Memoized for `FileList`'s reason, and harder: this view re-renders on every
/// session event — a streaming turn is one per delta — while a row's props only
/// move when the reader expands something or a relist lands. Without it a tree
/// with a few hundred rows open reconciles all of them at the speed an agent
/// types, which is how a view that only *reads* manages to freeze the window.
const Row = memo(function Row({
  entry,
  depth,
  expanded,
  selected,
  cursor,
  onActivate,
}: {
  entry: DirEntry;
  depth: number;
  expanded: boolean;
  selected: boolean;
  cursor: boolean;
  onActivate: (entry: DirEntry) => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <button
      type="button"
      role="treeitem"
      // The tree is one tab stop, not one per row: the container takes the tab
      // and the arrows walk from there, where leaving a large tree otherwise
      // meant tabbing past every file in it. Focus still lands here, since
      // `focus()` ignores this and the cursor effect above is what moves it.
      tabIndex={-1}
      aria-expanded={entry.isDir ? expanded : undefined}
      aria-selected={selected}
      onClick={() => onActivate(entry)}
      data-path={entry.path}
      title={entry.path}
      style={{ paddingLeft: 8 + depth * INDENT }}
      className={cn(
        "flex w-full items-center gap-1.5 py-1 pr-2 text-left text-ui",
        selected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50",
        // The keyboard's own row, drawn where it is not also the open file. A
        // ring rather than a second fill, or two rows would read as two
        // selections.
        cursor && !selected && "ring-1 ring-inset ring-border",
        // VS Code's grey for what git ignores. Dimmed, never hidden — the tree
        // has to say what is on disk.
        entry.ignored ? "text-muted-foreground" : "text-sidebar-foreground",
      )}
    >
      {entry.isDir ? (
        <Chevron className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      ) : (
        <FileIcon path={entry.path} />
      )}
      <span className="min-w-0 truncate">{entry.name}</span>
    </button>
  );
});
