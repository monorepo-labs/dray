import {
  ChatBubbleOvalLeftIcon,
  DocumentPlusIcon,
} from "@heroicons/react/16/solid";
import { Folder, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useReducer, useRef } from "react";

import Favicon, { hostOf } from "@/components/browser/Favicon";
import FileIcon from "@/components/FileIcon";
import GlobeFilledIcon from "@/components/icons/GlobeFilledIcon";
import ShortcutKeys from "@/components/ShortcutKeys";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDragReorder } from "@/hooks/useDragReorder";
import { useHotkey } from "@/hooks/useHotkey";
import { activateFile, closeFile, useOpenFiles } from "@/hooks/useOpenFiles";
import {
  activateBlankTab,
  activateTab,
  closeBlankTab,
  closeTab,
  setPendingTab,
  useBlankTabs,
  useBrowserTabs,
  usePendingTab,
  useRecording,
} from "@/lib/browser";
import { tabLabels } from "@/lib/fileTree";
import { moveKey, reconcile, type TabKey } from "@/lib/tabOrder";
import { BranchButton } from "@/components/layout/SessionHeader";
import { cn } from "@/lib/utils";

/// Which view fills the main column.
export const VIEW_TABS = ["chat", "browser", "changes", "files"] as const;

export type ViewTab = (typeof VIEW_TABS)[number];

/// The pointer crosses this row on its way to everything below it, so a
/// tooltip waits for a hover that means it — the crew's own delay.
const TIP_DELAY = 700;

/// Where a fresh session's row starts.
const DEFAULT_ORDER: TabKey[] = ["chat", "browser", "changes", "files"];

/// Each session's row as the reader arranged it. In memory, like the view tab
/// itself: a restart puts every row back to the default.
// ponytail: module map written during render, idempotent; a store if anything else needs to read it.
const orders = new Map<string, TabKey[]>();

// ponytail: one row is ever mounted (the shown session's), so one slot.
let closeActive: (() => boolean) | null = null;

/// Closes the row's lit tab the way its cross does — moving to whatever sat
/// beside it in the row — for ⌘W, whose binding lives in `App`. False where
/// the lit tab cannot be closed, so the caller can fall through.
export function closeActiveTab(): boolean {
  return closeActive?.() ?? false;
}

/// Which of Diff and Files the reader has put in a session's row. Both start
/// out, unlike the browser: + adds them, their cross takes them away again.
type Added = { changes: boolean; files: boolean };
const NONE: Added = { changes: false, files: false };
// ponytail: same bargain as `orders`.
const added = new Map<string, Added>();

/// Solid marks, the way a page's favicon is a filled mark rather than a line
/// drawing, in the muted grey every icon here takes.
const MARK = "size-4 shrink-0 text-muted-foreground";

type Item = {
  key: TabKey;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  pick: () => void;
  close?: () => void;
  locked?: boolean;
  /// Sized by its own label rather than by the row.
  fixed?: boolean;
};

/// The titlebar as a browser's tab strip.
///
/// One row the reader arranges however they like: the session's chat, its
/// diff, the browser's pages and the open files are all tabs of it, and any of
/// them can be dragged anywhere. Files with nothing open keeps a stand-in tab
/// so it can still be reached; the browser has none. ⌘1–⌘9 go by position, and +
/// at the end opens a page.
///
/// **It never scrolls.** Tabs shrink together — the active one holds its full
/// width, the rest give way to 100px and past that to an icon — so every tab
/// stays one click away.
export default function ViewTabs({
  sessionId,
  title,
  tab,
  onChange,
  branch,
  cwd,
  alignX = 0,
}: {
  sessionId: string;
  /// The session's branch and directory, drawn at the row's far end.
  branch?: string | null;
  cwd?: string;
  /// Where the sheet starts, from the header's left. The row lines up with it.
  alignX?: number;
  /// The chat's tab, which stands for the session: `project / title`.
  title: string;
  tab: ViewTab;
  onChange: (tab: ViewTab) => void;
}) {
  const loadedPages = useBrowserTabs(sessionId);
  const pages = loadedPages ?? [];
  const pending = usePendingTab(sessionId);
  const blanks = useBlankTabs(sessionId);
  // The agent's next verb goes to whichever page is active, so the reader
  // cannot move it mid-recording — the panel strip's own rule.
  const recording = useRecording(sessionId);
  const { open: files, active: activeFile } = useOpenFiles(sessionId);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const fileLabels = tabLabels(files.map((f) => f.path));

  // The view on screen always has its tab, however it was reached — the Diff
  // button in the panel, a file link in the chat — so the row never shows a
  // view with nothing lit for it.
  const shown: Added = {
    changes: (added.get(sessionId) ?? NONE).changes || tab === "changes",
    files: (added.get(sessionId) ?? NONE).files || tab === "files",
  };
  added.set(sessionId, shown);
  const setShown = (kind: keyof Added, on: boolean) => {
    added.set(sessionId, { ...(added.get(sessionId) ?? NONE), [kind]: on });
    bump();
  };
  const newTab = () => {
    if (recording) return;
    onChange("browser");
    setPendingTab(sessionId, true);
  };
  // From anywhere, whatever else is open: the chord every browser gives it.
  useHotkey("browser.newTab", newTab);

  const present: Item[] = [
    {
      key: "chat",
      icon: <ChatBubbleOvalLeftIcon className={MARK} />,
      label: title,
      active: tab === "chat",
      pick: () => onChange("chat"),
    },
    ...(shown.changes
      ? [
          {
            key: "changes",
            icon: <DocumentPlusIcon className={MARK} />,
            label: "Diff",
            active: tab === "changes",
            pick: () => onChange("changes"),
            close: () => setShown("changes", false),
            fixed: true,
          },
        ]
      : []),
    ...pages.map((page) => ({
      key: `page:${page.id}`,
      icon: <Favicon tab={page} />,
      label: page.error ? "Can't reach page" : page.title || hostOf(page.url),
      active: tab === "browser" && page.active && !pending,
      locked: recording,
      pick: () => {
        onChange("browser");
        setPendingTab(sessionId, false);
        if (!page.active) void activateTab(sessionId, page.id);
      },
      close: () => void closeTab(sessionId, page.id),
    })),
    ...blanks.ids.map((id) => ({
      key: `blank:${id}`,
      icon: <GlobeFilledIcon className={MARK} />,
      label: "New tab",
      active: tab === "browser" && blanks.active === id,
      locked: recording,
      pick: () => {
        onChange("browser");
        activateBlankTab(sessionId, id);
      },
      close: () => closeBlankTab(sessionId, id),
    })),
    ...(files.length === 0 && shown.files
      ? [
          {
            key: "files",
            // The project picker's own folder, so a folder means one thing.
            icon: (
              <Folder className="size-3.5 shrink-0 fill-current text-muted-foreground" />
            ),
            label: "Files",
            active: tab === "files",
            pick: () => onChange("files"),
            close: () => setShown("files", false),
            fixed: true,
          },
        ]
      : []),
    ...files.map((file, i) => ({
      key: `file:${file.path}`,
      icon: <FileIcon path={file.path} className="size-3.5 shrink-0" />,
      label: fileLabels[i],
      active: tab === "files" && file.path === activeFile,
      pick: () => {
        onChange("files");
        activateFile(sessionId, file.path);
      },
      close: () => closeFile(sessionId, file.path),
    })),
  ];

  const byKey = new Map(present.map((item) => [item.key, item]));
  const order = reconcile(orders.get(sessionId) ?? DEFAULT_ORDER, [
    ...byKey.keys(),
  ]);
  orders.set(sessionId, order);
  const items = order.map((key) => byKey.get(key)!);

  const drag = useDragReorder(
    items,
    (item) => item.key,
    (item, _, to) => {
      orders.set(
        sessionId,
        moveKey(orders.get(sessionId) ?? order, item.key, to),
      );
      bump();
    },
    "x",
  );

  // The row is pushed right to start where the sheet does. Worked
  // out in CSS from what sits before the row — the header names that as
  // `--tabs-lead` — rather than measured: a layout read on every render forced
  // a full layout each time, and switching sessions renders many times over.
  // The row's `px-1` puts the tab 4px in from its edge; `-mx-1` is the floor.
  // Every row, not a lone title alone: aligned only when alone, the row slid
  // across on every switch between one tab and several.
  const lone = drag.shown.length === 1;
  const align = {
    marginLeft:
      alignX > 0 ? `max(-0.25rem, calc(${alignX}px - 0.25rem - var(--tabs-lead)))` : "-0.25rem",
    transition: "margin-left 125ms cubic-bezier(0.2, 0, 0, 1)",
    // Here rather than as classes so `duration-300` does not also ease the
    // margin at entrance speed.
    animation: "enter 300ms ease-out 150ms backwards",
  };

  // The browser view with nothing in the row lit for it — its tab shut by ⌘W
  // or by the agent, leaving only new tabs nobody is on, or nothing at all —
  // moves to the tab that sat beside it, as a browser does. A layout effect,
  // so the unlit view is never painted. Safe against a pick in flight:
  // `activateTab` lights its page at once, before Chromium answers.
  const lastRow = useRef<{ keys: TabKey[]; at: number }>({ keys: [], at: -1 });
  const browserUnlit =
    tab === "browser" && loadedPages !== null && !drag.shown.some((item) => item.active);
  useLayoutEffect(() => {
    if (!browserUnlit) {
      lastRow.current = {
        keys: drag.shown.map((item) => item.key),
        at: drag.shown.findIndex((item) => item.active),
      };
      return;
    }
    const { keys, at } = lastRow.current;
    const near = [...keys.slice(0, Math.max(at, 0)).reverse(), ...keys.slice(at + 1)];
    const heir = near.map((key) => drag.shown.find((item) => item.key === key)).find(Boolean);
    (heir ?? drag.shown[0])?.pick();
  });

  // ⌘1–⌘8 by position and ⌘9 the last, every browser's numbering.
  const pickAt = (i: number) => items[i] && !items[i].locked && items[i].pick();
  useHotkey("tab.1", () => pickAt(0));
  useHotkey("tab.2", () => pickAt(1));
  useHotkey("tab.3", () => pickAt(2));
  useHotkey("tab.4", () => pickAt(3));
  useHotkey("tab.5", () => pickAt(4));
  useHotkey("tab.6", () => pickAt(5));
  useHotkey("tab.7", () => pickAt(6));
  useHotkey("tab.8", () => pickAt(7));
  useHotkey("tab.9", () => pickAt(items.length - 1));
  // ⌘⇧[ and ⌘⇧], wrapping at the ends the way a browser's do.
  const step = (delta: number) => {
    const at = items.findIndex((item) => item.active);
    pickAt((at + delta + items.length) % items.length);
  };
  useHotkey("tab.prev", () => step(-1));
  useHotkey("tab.next", () => step(1));

  // Closing the tab on screen moves to the one beside it in this row, as a
  // browser does, rather than to whatever its own kind would pick.
  // Closing the last file is the exception: Files takes its slot, so the
  // reader stays in that view. A browser tab simply goes.
  const closeAt = (i: number) => {
    const item = drag.shown[i];
    const last = item.key.startsWith("file:") && files.length === 1;
    if (item.active && !last) (drag.shown[i - 1] ?? drag.shown[i + 1])?.pick();
    item.close?.();
  };

  useEffect(() => {
    closeActive = () => {
      const i = drag.shown.findIndex((item) => item.active && item.close && !item.locked);
      if (i === -1) return false;
      closeAt(i);
      return true;
    };
    return () => {
      closeActive = null;
    };
  });

  // What + can still add. With Diff and Files both in the row it is a plain
  // new-tab button, the one thing left to offer.
  const offer = [
    !shown.changes && {
      key: "changes",
      icon: <DocumentPlusIcon className={MARK} />,
      label: "Diff",
      add: () => {
        setShown("changes", true);
        onChange("changes");
      },
    },
    !shown.files &&
      files.length === 0 && {
        key: "files",
        icon: (
          <Folder className="size-3.5 shrink-0 fill-current text-muted-foreground" />
        ),
        label: "Files",
        add: () => {
          setShown("files", true);
          onChange("files");
        },
      },
  ].filter((o) => !!o);
  const plusClass =
    "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50";

  return (
    // Clips rather than scrolls: past every tab's icon floor there is nothing
    // left to give, and a scrolling row hides tabs the reader cannot see.
    // Full height and inset, so the clip lands past the active tab's shadow
    // and ring rather than on them.
    <div
      ref={drag.list}
      role="tablist"
      className={cn(
        "-mx-1 flex min-w-0 flex-1 items-center gap-0.5 self-stretch overflow-hidden px-1 fade-in slide-in-from-left-3",
      )}
      style={align}
    >
      {drag.shown.map((item, i) => (
        <ItemTab
          // Remounted when the chat turns between a lone title and a tab, or
          // its min-width eases across the change and the switch drags.
          key={item.key === "chat" ? `chat:${lone}` : item.key}
          icon={item.icon}
          label={item.label}
          active={item.active}
          locked={item.locked}
          fixed={item.fixed}
          onPick={item.pick}
          onClose={item.close && (() => closeAt(i))}
          onPointerDown={(e) => drag.start(e, i)}
          transform={drag.offset(i)}
          held={drag.drag?.from === i}
          gliding={!!drag.drag && drag.drag.from !== i}
          // The chat alone is a title, not a tab: nothing beside it to pick
          // between, so no pill to say which is picked.
          plain={drag.shown.length === 1}
          hint={
            drag.shown.length > 1 && (
              <>
                Switch tabs
                <ShortcutKeys ids={["tab.prev", "tab.next"]} />
              </>
            )
          }
        />
      ))}
      {/* Last, after every tab, where a browser keeps it. Past the items, so
          the drag hook leaves it alone. */}
      {offer.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Add a tab" className={plusClass}>
              <Plus className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-auto min-w-40">
            {offer.map((o) => (
              <DropdownMenuItem key={o.key} onSelect={o.add}>
                {o.icon}
                {o.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem disabled={recording} onSelect={newTab}>
              <GlobeFilledIcon className={MARK} />
              Browser
              <ShortcutKeys ids={["browser.newTab"]} className="ml-auto shrink-0 pl-4" />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Tooltip delayDuration={TIP_DELAY}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="New tab"
              disabled={recording}
              onClick={newTab}
              className={plusClass}
            >
              <Plus className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            New tab
            <ShortcutKeys ids={["browser.newTab"]} />
          </TooltipContent>
        </Tooltip>
      )}
      {/* At the row's far end, where it gives way before any tab does. */}
      {branch && cwd && (
        <span className="ml-auto flex min-w-6.5 shrink-[999] pl-2 text-ui animate-in fade-in duration-200">
          <BranchButton branch={branch} cwd={cwd} />
        </span>
      )}
    </div>
  );
}

/// A page or an open file. Shrinks with the others, the way a browser's tabs
/// do: full width while active, down to 100px for the rest and past that to
/// its icon. A container, so the close cross and the label can answer to the
/// tab's own width.
export function ItemTab({
  icon,
  label,
  active,
  locked = false,
  onPick,
  onClose,
  onPointerDown,
  transform,
  held = false,
  gliding = false,
  fixed = false,
  plain = false,
  hint,
  className,
  ...rest
}: Omit<React.ComponentProps<"div">, "onPointerDown"> & {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  /// Neither picked nor closed, while a recording holds the strip.
  locked?: boolean;
  onPick: () => void;
  /// Absent on the view tabs, which are never closed.
  onClose?: () => void;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  transform?: string;
  held?: boolean;
  gliding?: boolean;
  /// Sized by its own label rather than by the row: Browser, Diff and Files.
  fixed?: boolean;
  /// A delayed tooltip naming the chords that move through this tab's row —
  /// the only place the header says they exist.
  hint?: React.ReactNode;
  /// Drawn as its icon and label alone, with no pill and sized to its label.
  plain?: boolean;
}) {
  const pick = locked ? undefined : onPick;
  const tab = (
    // A div rather than a button, since the close control sits inside it.
    <div
      {...rest}
      role="tab"
      aria-selected={active}
      aria-label={label}
      aria-disabled={locked || undefined}
      tabIndex={locked ? -1 : 0}
      onClick={pick}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        pick?.();
      }}
      // Middle-click closes. `auxClick`, or a press begun on one tab and
      // released on another closes the wrong one.
      onAuxClick={(e) => {
        if (e.button !== 1 || locked || !onClose) return;
        e.preventDefault();
        onClose();
      }}
      onPointerDown={onPointerDown}
      style={{ transform }}
      className={cn(
        "group flex cursor-default items-center gap-1.5 h-7 rounded-md pl-2 text-ui select-none",
        "transition-[color,background-color,min-width] duration-150 ease-out",
        onClose ? "pr-1" : "pr-2",
        fixed
          ? "shrink-0"
          : plain
            ? "shrink-0"
            : // The chat has no icon to shrink to, so it stops at 100px.
            cn(
              "basis-44",
              active ? "min-w-44" : icon ? "min-w-6" : "min-w-[100px]",
            ),
        // Only a tab sized by the row; a container's width ignores its
        // content, which would collapse a fixed one to its padding.
        onClose && !fixed && "@container",
        // Raised out of the darker strip, the way a browser's active tab is:
        // the segmented control's thumb, which is that same picture small.
        plain
          ? "text-foreground"
          : active || held
          ? "bg-surface-thumb text-foreground shadow-(--shadow-button) ring-1 ring-hairline dark:shadow-none"
          : locked
            ? "text-muted-foreground opacity-50"
            : "text-muted-foreground hover:text-foreground",
        held && "relative z-10",
        gliding && "transition-[color,background-color,min-width,transform]",
        className,
      )}
    >
      {icon}
      {/* Faded rather than ellipsed, so a cut title still reads as a word. */}
      <span
        className={cn(
          "min-w-0 flex-1 overflow-hidden whitespace-nowrap @max-[40px]:hidden",
          // Only where the row can cut it: a fixed label is never short of room.
          !fixed && !plain &&
            "mask-[linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]",
        )}
      >
        {label}
      </span>
      {/* No tooltip: a cross on a tab says what it does, the way it does in
          every browser. */}
      {onClose && !locked && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={(e) => {
            // Or closing a background tab would pick it on the way out.
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            "shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground @max-[100px]:hidden",
            // Always on the active tab, on hover elsewhere: a row of
            // crosses is a row of things to press by accident.
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <X className="size-3" strokeWidth={2} />
        </button>
      )}
    </div>
  );
  if (!hint) return tab;
  return (
    <Tooltip delayDuration={TIP_DELAY}>
      <TooltipTrigger asChild>{tab}</TooltipTrigger>
      <TooltipContent side="bottom">{hint}</TooltipContent>
    </Tooltip>
  );
}
