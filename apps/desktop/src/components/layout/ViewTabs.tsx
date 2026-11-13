import {
  ChatBubbleOvalLeftIcon,
  DocumentPlusIcon,
} from "@heroicons/react/16/solid";
import { Folder, Plus, Server, X } from "lucide-react";
import { useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

import AgentBeam from "@/components/browser/AgentBeam";
import BotAvatar from "@/components/BotAvatar";
import MachineMark from "@/components/MachineMark";
import Favicon, { hostOf } from "@/components/browser/Favicon";
import FileIcon from "@/components/FileIcon";
import GlobeFilledIcon from "@/components/icons/GlobeFilledIcon";
import Orb from "@/components/Orb";
import ShortcutKeys from "@/components/ShortcutKeys";
import TabMenu from "@/components/browser/TabMenu";
import { ContextMenuTrigger } from "@/components/ui/context-menu";
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
import { serverName, useServers } from "@/lib/servers";
import { LOCAL, type ServerId } from "@/lib/transport";
import { useDigitHotkey, useHotkey } from "@/hooks/useHotkey";
import {
  activateFile,
  closeFile,
  openFilesFor,
  reopenFile,
  useOpenFiles,
} from "@/hooks/useOpenFiles";
import {
  activateBlankTab,
  activateTab,
  addBlankTab,
  closeBlankTab,
  closeTab,
  openInBrowser,
  setPendingTab,
  useBlankTabs,
  useBrowserTabs,
  useParkedTabs,
  usePendingTab,
  useRecordedTab,
} from "@/lib/browser";
import { seededAvatar } from "@/lib/botAvatar";
import { tabLabels } from "@/lib/fileTree";
import {
  markClosedSlot,
  moveKey,
  moveLastClosed,
  popClosedTab,
  pushClosedTab,
  reconcile,
  type TabKey,
} from "@/lib/tabOrder";
import BranchButton from "@/components/layout/BranchButton";
import { IS_MAC } from "@/lib/platform";
import {
  addSplit,
  filePaneStore,
  isSplit,
  setPaneHeads,
  setSplitDrag,
  splitTarget,
  useSplitPanes,
  type PaneHead,
} from "@/lib/splitPanes";
import { cn } from "@/lib/utils";

/// Which view fills the main column.
export const VIEW_TABS = ["chat", "browser", "changes", "files"] as const;

/// `pick` is a bot row's Diff or Files tab on a session it picked (#892).
export type ViewTab = (typeof VIEW_TABS)[number] | "pick";

/// The pointer crosses this row on its way to everything below it, so a
/// tooltip waits for a hover that means it — the crew's own delay.
const TIP_DELAY = 700;

/// Where a fresh session's row starts.
const DEFAULT_ORDER: TabKey[] = ["chat", "changes", "files"];

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

export type TurnKind = "changes" | "files";

/// What the new-tab page may turn its blank into, set by the row since the
/// row's order and its Diff/Files state live here. Keyed on the browser it
/// lists, `kinds` comma-joined so the snapshot only moves when they do.
// ponytail: one row mounted, one slot, same as `closeActive`.
let turnSlot: { browserId: string; kinds: string; turn: (kind: TurnKind) => void } | null = null;
const turnListeners = new Set<() => void>();
function setTurnSlot(next: typeof turnSlot) {
  const moved = next?.browserId !== turnSlot?.browserId || next?.kinds !== turnSlot?.kinds;
  turnSlot = next;
  if (moved) for (const l of turnListeners) l();
}

/// The views a blank tab of `browserId`'s can become, and the call that
/// turns the one on screen into one of them in its own slot.
export function useTurnNewTab(browserId: string): { kinds: TurnKind[]; turn: (kind: TurnKind) => void } {
  const kinds = useSyncExternalStore(
    (l) => {
      turnListeners.add(l);
      return () => turnListeners.delete(l);
    },
    () => (turnSlot?.browserId === browserId ? turnSlot.kinds : ""),
  );
  return {
    kinds: kinds ? (kinds.split(",") as TurnKind[]) : [],
    turn: (kind) => turnSlot?.turn(kind),
  };
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
// The project picker's own folder, so a folder means one thing.
const FOLDER = <Folder className="size-3.5 shrink-0 fill-current text-muted-foreground" />;

/// A bot's tasks open in its row, each a tab that shows the task's own chat.
export type TaskTabsProps = {
  /// `machine`: the task's server, marked on its tab where it is not This Mac.
  items: { sessionId: string; title: string; working: boolean; machine: ServerId }[];
  /// The task on screen; while one is, nothing of the bot's own is lit.
  lit: string | null;
  onPick: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  /// ⌘⇧T: back in the row, the reader left where they are.
  onReopen: (sessionId: string) => void;
};

/// A bot chat's Diff and Files tabs, each on the session its side column
/// picked (#892). + offers both every time, so several of each can be open.
export type PickTabsProps = {
  items: {
    id: string;
    kind: "changes" | "files";
    target: string;
    /// The picked session's title.
    title: string;
    /// Where a Files pick's open files live (`pickFilesKey`).
    filesKey: string;
  }[];
  /// The pick on screen, while the row's view is `pick`.
  lit: string | null;
  /// Diff has a task to show. Files always has the bot's own folder.
  canDiff: boolean;
  onPick: (id: string) => void;
  /// Answers the new pick's id, or null where there was nothing to pick.
  onAdd: (kind: "changes" | "files") => string | null;
  onClose: (id: string) => void;
  /// ⌘⇧T: back in the row on the same session, unlit. Answers the new id.
  onReopen: (kind: "changes" | "files", target: string) => string;
};

type Item = {
  key: TabKey;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  pick: () => void;
  close?: () => void;
  duplicate?: () => void;
  locked?: boolean;
  /// Sized by its own label rather than by the row.
  fixed?: boolean;
  rename?: Rename;
  overlay?: React.ReactNode;
  /// The last file of its view: closing it hands its slot back to the view's
  /// stand-in, which stays lit, rather than moving to a neighbour.
  keepsView?: boolean;
  /// The remote server the tab's session runs on; absent for This Mac.
  machine?: string;
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
  browserId = sessionId,
  title,
  tab,
  onChange,
  branch,
  cwd,
  alignX = 0,
  rename,
  machine,
  working = false,
  tasks,
  picks,
}: {
  /// Whose browser pages the row lists: a bot's tasks share the bot chat's.
  browserId?: string;
  /// A bot chat's Diff and Files picks.
  picks?: PickTabsProps;
  /// A bot chat's open tasks, after everything else in its row.
  tasks?: TaskTabsProps;
  /// Mid-turn: off Chat, the chat tab's icon says so, since the transcript
  /// that would is not on screen.
  working?: boolean;
  sessionId: string;
  /// The session's own title and how to change it; absent where the chat
  /// stands for a group rather than one session.
  rename?: Rename;
  /// The session's branch and directory, drawn at the row's far end.
  branch?: string | null;
  cwd?: string;
  /// Where the sheet starts, from the header's left. The row lines up with it.
  alignX?: number;
  /// The chat's tab, which stands for the session: `project / title`.
  title: string;
  /// Which machine the session runs on. This Mac is never named: no name is
  /// what says local.
  machine?: ServerId;
  tab: ViewTab;
  onChange: (tab: ViewTab) => void;
}) {
  // Read for the re-render alone: a server renamed moves the name in the tab.
  useServers();
  const server = machine && machine !== LOCAL ? serverName(machine) : null;
  const loadedPages = useBrowserTabs(browserId);
  const pages = loadedPages ?? [];
  const pending = usePendingTab(browserId);
  const blanks = useBlankTabs(browserId);
  const parkedPages = useParkedTabs(browserId);
  // The page being recorded cannot be closed; every other tab stays the reader's.
  const recorded = useRecordedTab(browserId);
  const { open: files, active: activeFile } = useOpenFiles(sessionId);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const fileLabels = tabLabels(files.map((f) => f.path));
  // A task lit in the row puts every view of the bot's own out of it, though
  // `tab` still says which one the bot's chat goes back to.
  const own: ViewTab | null = tasks?.lit ? null : tab;

  // The view on screen always has its tab, however it was reached — the Diff
  // button in the panel, a file link in the chat — so the row never shows a
  // view with nothing lit for it.
  const shown: Added = {
    changes: (added.get(sessionId) ?? NONE).changes || own === "changes",
    files: (added.get(sessionId) ?? NONE).files || own === "files",
  };
  added.set(sessionId, shown);
  const setShown = (kind: keyof Added, on: boolean) => {
    if (!on) pushClosedTab(sessionId, { key: kind });
    added.set(sessionId, { ...(added.get(sessionId) ?? NONE), [kind]: on });
    bump();
  };
  const newTab = () => {
    onChange("browser");
    setPendingTab(browserId, true);
  };
  // From anywhere, whatever else is open: the chord every browser gives it.
  useHotkey("browser.newTab", newTab);

  const present: Item[] = [
    {
      key: "chat",
      icon:
        working && own !== "chat" ? (
          <Orb state="working" label="Working" size={16} />
        ) : (
          <ChatBubbleOvalLeftIcon className={MARK} />
        ),
      label: title,
      active: own === "chat",
      pick: () => onChange("chat"),
      rename,
    },
    ...(shown.changes
      ? [
          {
            key: "changes",
            icon: <DocumentPlusIcon className={MARK} />,
            label: "Diff",
            active: own === "changes",
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
      active: own === "browser" && page.active && !pending,
      overlay: <AgentBeam tab={page.id} />,
      locked: page.id === recorded,
      pick: () => {
        onChange("browser");
        setPendingTab(browserId, false);
        if (!page.active) void activateTab(browserId, page.id);
      },
      close: () => {
        void closeTab(browserId, page.id);
        moveLastClosed(browserId, sessionId);
      },
      duplicate: page.url
        ? () => {
            onChange("browser");
            setPendingTab(browserId, false);
            void openInBrowser(browserId, page.url, true).catch(() => undefined);
          }
        : undefined,
    })),
    ...blanks.ids.map((id) => ({
      key: `blank:${id}`,
      icon: parkedPages[id] ? <Favicon tab={parkedPages[id]} /> : <GlobeFilledIcon className={MARK} />,
      label: parkedPages[id] ? parkedPages[id].title || hostOf(parkedPages[id].url) : "New tab",
      active: own === "browser" && blanks.active === id,
      pick: () => {
        onChange("browser");
        activateBlankTab(browserId, id);
      },
      close: () => {
        closeBlankTab(browserId, id);
        moveLastClosed(browserId, sessionId);
      },
    })),
    ...(files.length === 0 && shown.files
      ? [
          {
            key: "files",
            icon: FOLDER,
            label: "Files",
            active: own === "files",
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
      active: own === "files" && file.path === activeFile,
      pick: () => {
        onChange("files");
        activateFile(sessionId, file.path);
      },
      close: () => closeFile(sessionId, file.path),
      keepsView: files.length === 1,
    })),
    ...(picks?.items ?? []).flatMap((p): Item[] => {
      const lit = own === "pick" && picks?.lit === p.id;
      const pick = () => picks?.onPick(p.id);
      const standIn: Item = {
        key: `pick:${p.id}`,
        icon: p.kind === "changes" ? <DocumentPlusIcon className={MARK} /> : FOLDER,
        label: p.title,
        active: lit,
        pick,
        close: () => {
          pushClosedTab(sessionId, { key: `pick:${p.id}`, pick: { kind: p.kind, target: p.target } });
          picks?.onClose(p.id);
        },
      };
      if (p.kind === "changes") return [standIn];
      // A Files pick is the Files tab over again: its files are tabs of the
      // row, and the stand-in holds their place while none is open.
      const { open, active } = openFilesFor(p.filesKey);
      if (open.length === 0) return [standIn];
      const labels = tabLabels(open.map((f) => f.path));
      return open.map((file, i) => ({
        key: `pickfile:${p.id}:${file.path}`,
        icon: <FileIcon path={file.path} className="size-3.5 shrink-0" />,
        label: labels[i],
        active: lit && file.path === active,
        pick: () => {
          pick();
          activateFile(p.filesKey, file.path);
        },
        close: () => {
          closeFile(p.filesKey, file.path);
          // On the row's own stack, where ⌘⇧T and the slot are read.
          pushClosedTab(sessionId, {
            key: `pickfile:${p.id}:${file.path}`,
            file: { store: p.filesKey, path: file.path },
          });
        },
        keepsView: open.length === 1,
      }));
    }),
    ...(tasks?.items ?? []).map((task) => ({
      key: `task:${task.sessionId}`,
      machine: task.machine !== LOCAL ? serverName(task.machine) : undefined,
      icon: task.working ? (
        <Orb state="working" label="Working" size={16} />
      ) : (
        <BotAvatar seed={task.sessionId} avatar={seededAvatar(task.sessionId)} className="block size-4 shrink-0 scale-[1.18]" />
      ),
      label: task.title,
      active: tasks?.lit === task.sessionId,
      pick: () => tasks?.onPick(task.sessionId),
      close: () => {
        pushClosedTab(sessionId, { key: `task:${task.sessionId}` });
        tasks?.onClose(task.sessionId);
      },
    })),
  ];

  const byKey = new Map(present.map((item) => [item.key, item]));
  const order = reconcile(orders.get(sessionId) ?? DEFAULT_ORDER, [
    ...byKey.keys(),
  ]);
  orders.set(sessionId, order);
  // A tab split out keeps its slot in `order`, so closing its pane puts it
  // back where it was; it is only left out of what is drawn.
  const splits = useSplitPanes(sessionId);
  const items = order.map((key) => byKey.get(key)!).filter((item) => !isSplit(sessionId, item.key));

  // The panes draw the same icon and label their tab did.
  useLayoutEffect(() => {
    const heads = new Map<TabKey, PaneHead>();
    for (const key of splits) {
      const item = byKey.get(key);
      const pick = key.startsWith("pick:") ? picks?.items.find((p) => `pick:${p.id}` === key) : undefined;
      if (item) heads.set(key, { icon: item.icon, label: item.label });
      else if (pick)
        heads.set(key, {
          icon: pick.kind === "changes" ? <DocumentPlusIcon className={MARK} /> : FOLDER,
          label: pick.title,
        });
    }
    setPaneHeads(sessionId, heads);
  });

  // Out of the row into a pane right of the main view. The tab on screen
  // hands the view to its neighbour first, as closing it would. A file takes
  // a store of its own with it, so the pane's Files is that file's alone.
  const splitOut = (item: Item) => {
    if (item.active) {
      const at = items.indexOf(item);
      [items[at - 1], items[at + 1], ...items].find((t) => t && t !== item)?.pick();
    }
    let key = item.key;
    if (key.startsWith("page:")) {
      const page = pages.find((p) => `page:${p.id}` === key);
      const heir = pages.find((p) => p !== page && !isSplit(sessionId, `page:${p.id}`));
      if (page?.active && heir) void activateTab(browserId, heir.id);
    } else if (key === "files" || key.startsWith("file:")) {
      key = `filepane:${crypto.randomUUID()}`;
      if (item.key.startsWith("file:")) {
        const path = item.key.slice("file:".length);
        closeFile(sessionId, path);
        reopenFile(filePaneStore(sessionId, key), path);
      } else {
        added.set(sessionId, { ...(added.get(sessionId) ?? NONE), files: false });
      }
    } else if (key.startsWith("pickfile:")) {
      key = `pick:${key.split(":")[1]}`;
    }
    addSplit(sessionId, key);
  };
  // The chat is what the panes sit beside, and a blank has no page to show.
  const splittable = (item: Item) =>
    /^(page:|changes$|files$|file:|task:|pick:|pickfile:)/.test(item.key) && (IS_MAC || !item.key.startsWith("page:"));

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
    {
      over: (item, at) => {
        const target = at && splittable(item) ? splitTarget(at.x, at.y, splits.length) : null;
        setSplitDrag(target ? { sessionId, key: item.key, label: target === "room" ? "Split right" : null } : null);
        return target === "room";
      },
      drop: splitOut,
    },
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
    own === "browser" && loadedPages !== null && !drag.shown.some((item) => item.active);
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
  const pickAt = (i: number) => items[i]?.pick();
  useDigitHotkey("tab.pick", (slot) => pickAt(slot === 8 ? items.length - 1 : slot));
  // ⌘⇧[ and ⌘⇧], wrapping at the ends the way a browser's do.
  const step = (delta: number) => {
    const at = items.findIndex((item) => item.active);
    pickAt((at + delta + items.length) % items.length);
  };
  useHotkey("tab.prev", () => step(-1));
  useHotkey("tab.next", () => step(1));

  // ⌘⇧T, every browser's chord. Puts the tab back and leaves the reader where
  // they are; a page comes back parked in a blank and loads when picked, so
  // nothing a recording holds is moved.
  const reopen = () => {
    const entry = popClosedTab(sessionId);
    if (!entry) return;
    let key = entry.key;
    if (entry.pick) {
      if (!picks) return;
      key = `pick:${picks.onReopen(entry.pick.kind, entry.pick.target)}`;
    } else if (entry.file) {
      // Only into the pick still on that target, or it lands in a store
      // nothing draws.
      const store = entry.file.store;
      if (!picks?.items.some((p) => p.filesKey === store)) return;
      reopenFile(store, entry.file.path);
    } else if (key === "changes" || key === "files") setShown(key, true);
    else if (key.startsWith("file:")) reopenFile(sessionId, key.slice("file:".length));
    else if (key.startsWith("task:")) tasks?.onReopen(key.slice("task:".length));
    else key = `blank:${addBlankTab(browserId, entry.page)}`;
    if (entry.at !== undefined) {
      orders.set(sessionId, moveKey(orders.get(sessionId) ?? order, key, entry.at));
    }
    bump();
  };
  useHotkey("tab.reopen", reopen);

  // Closing the tab on screen moves to the one beside it in this row, as a
  // browser does, rather than to whatever its own kind would pick.
  // Closing the last file is the exception: Files takes its slot, so the
  // reader stays in that view. A browser tab simply goes.
  const closeAt = (i: number) => {
    const item = drag.shown[i];
    const last = !!item.keepsView;
    if (item.active && !last) {
      [drag.shown[i - 1], drag.shown[i + 1], ...drag.shown].find((t) => t && t !== item)?.pick();
    }
    item.close?.();
    markClosedSlot(sessionId, item.key, i);
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

  // The new-tab page's Diff and Files cards. The blank on screen becomes the
  // view in its own slot; a view the row already holds is lit instead of
  // doubled, and the blank simply goes.
  const turn = (kind: TurnKind) => {
    const blank = blanks.active;
    if (blank === null) return;
    let key: TabKey | null = null;
    if (picks) {
      const id = picks.onAdd(kind);
      if (!id) return;
      key = `pick:${id}`;
    } else {
      if (kind === "changes" ? !shown.changes : !shown.files && files.length === 0) {
        setShown(kind, true);
        key = kind;
      }
      onChange(kind);
    }
    closeBlankTab(browserId, blank, false);
    if (key) {
      const at = `blank:${blank}`;
      orders.set(sessionId, (orders.get(sessionId) ?? order).map((k) => (k === at ? key : k)));
    }
    bump();
  };
  const turnKinds = picks && !picks.canDiff ? "files" : "changes,files";
  useEffect(() => setTurnSlot({ browserId, kinds: turnKinds, turn }));
  useEffect(() => () => setTurnSlot(null), []);

  // What + can still add. With Diff and Files both in the row it is a plain
  // new-tab button, the one thing left to offer.
  // A bot's row offers Diff and Files every time, each a new pick; its own
  // folder is no repository, so it has no Diff of its own to offer.
  const offer = picks
    ? [
        {
          key: "changes",
          icon: <DocumentPlusIcon className={MARK} />,
          label: "Diff",
          add: () => void picks.onAdd("changes"),
          disabled: !picks.canDiff,
        },
        { key: "files", icon: FOLDER, label: "Files", add: () => void picks.onAdd("files"), disabled: false },
      ]
    : [
    !shown.changes && {
      key: "changes",
      icon: <DocumentPlusIcon className={MARK} />,
      label: "Diff",
      add: () => {
        setShown("changes", true);
        onChange("changes");
      },
      disabled: false,
    },
    !shown.files &&
      files.length === 0 && {
        key: "files",
        icon: FOLDER,
        label: "Files",
        add: () => {
          setShown("files", true);
          onChange("files");
        },
        disabled: false,
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
      className="-mx-1 flex min-w-0 flex-1 items-center gap-0.5 self-stretch overflow-hidden px-1 fade-in slide-in-from-left-3"
      style={align}
    >
      {drag.shown.map((item, i) => (
        <ItemTab
          // Remounted when the chat turns between a lone title and a tab, or
          // its min-width eases across the change and the switch drags.
          // Per session too, so a rename left open does not follow the reader.
          key={item.key === "chat" ? `chat:${lone}:${sessionId}` : item.key}
          icon={item.icon}
          overlay={item.overlay}
          label={item.label}
          active={item.active}
          locked={item.locked}
          fixed={item.fixed}
          onPick={item.pick}
          rename={item.rename}
          machine={item.machine}
          onClose={item.close && (() => closeAt(i))}
          onDuplicate={item.duplicate}
          onPointerDown={(e) => drag.start(e, i)}
          transform={drag.offset(i)}
          held={drag.drag?.from === i}
          gliding={!!drag.drag && drag.drag.from !== i}
          // The chat alone is a title, not a tab: nothing beside it to pick
          // between, so no pill to say which is picked.
          plain={lone}
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
              <DropdownMenuItem key={o.key} disabled={o.disabled} onSelect={o.add}>
                {o.icon}
                {o.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={newTab}>
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
      {/* The chords that step the row, said beside it once there is a row to
          step. Wraps rather than shrinks: the zero-width opener holds the
          first line, so a hint that does not fit whole drops to a second
          line the fixed height clips, and no tab gives up width for it. */}
      {!lone && (
        <span className="flex h-7 min-w-0 flex-1 flex-wrap items-center overflow-hidden">
          <span aria-hidden className="h-7" />
          <span className="flex whitespace-nowrap pl-2 opacity-50">
            <ShortcutKeys ids={["tab.prev", "tab.next"]} />
          </span>
        </span>
      )}
      {/* At the row's far end, where it gives way before any tab does. */}
      {server && <RowMachine name={server} />}
      {branch && cwd && (
        <span className={cn("flex min-w-6.5 shrink-[999] pl-2 text-ui animate-in fade-in duration-200", !server && "ml-auto")}>
          <BranchButton branch={branch} cwd={cwd} />
        </span>
      )}
    </div>
  );
}

/// The row's far end names a remote session's machine; This Mac goes unnamed.
export function RowMachine({ name }: { name: string }) {
  return (
    <span className="ml-auto flex min-w-6.5 shrink-[999] items-center gap-1 overflow-hidden pl-2 text-ui text-muted-foreground animate-in fade-in duration-200">
      <Server className="size-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
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
  onDuplicate,
  onPointerDown,
  transform,
  held = false,
  gliding = false,
  fixed = false,
  plain = false,
  hint,
  rename,
  overlay,
  machine,
}: {
  icon: React.ReactNode;
  /// The remote server the tab's session runs on; absent for This Mac.
  machine?: string;
  /// Drawn over the whole tab, out of the row's flow: the agent's beam.
  overlay?: React.ReactNode;
  label: string;
  active: boolean;
  /// Not closed, while a recording films it.
  locked?: boolean;
  onPick: () => void;
  /// Absent on the view tabs, which are never closed.
  onClose?: () => void;
  /// A browser page's right-click Duplicate tab.
  onDuplicate?: () => void;
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
  /// Double-click, or Enter on the active tab, edits this in place of the label.
  rename?: Rename;
}) {
  const pick = onPick;
  const [renaming, setRenaming] = useState(false);
  const lastClick = useRef(-Infinity);
  // Closed by the tab going inactive, not only by blur: the drag hook cancels
  // the press on another tab, so focus never leaves the field.
  if (renaming && !active) setRenaming(false);
  // A div rather than a button, since the close control sits inside it.
  const tab = (
    <ContextMenuTrigger asChild disabled={!onDuplicate || locked}>
    <div
      role="tab"
      aria-selected={active}
      aria-label={label}
      tabIndex={0}
      onClick={(e) => {
        pick?.();
        // Counted here rather than on `dblclick`, which WebKit never fires
        // once the drag hook has cancelled the press's pointerdown.
        // Only presses on a tab already active count, so a double-click
        // that picks a tab does not also start renaming it.
        if (rename && active && e.timeStamp - lastClick.current < 400) setRenaming(true);
        lastClick.current = active ? e.timeStamp : -Infinity;
      }}
      onKeyDown={(e) => {
        // Not a key meant for the close cross inside.
        if (e.target !== e.currentTarget) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (rename && active && e.key === "Enter") setRenaming(true);
        else pick?.();
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
        "group relative flex cursor-default items-center gap-1.5 h-7 rounded-md pl-2 text-ui select-none",
        "transition-[color,background-color,min-width] duration-150 ease-out",
        onClose ? "pr-1" : "pr-2",
        fixed || plain
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
          : "text-muted-foreground hover:text-foreground",
        held && "z-10",
        gliding && "transition-[color,background-color,min-width,transform]",
      )}
    >
      {overlay}
      {icon}
      {renaming && rename ? (
        <TitleInput title={rename.title} onSave={rename.save} onDone={() => setRenaming(false)} />
      ) : (
      /* Faded rather than ellipsed, so a cut title still reads as a word. */
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
      )}
      <MachineMark machine={machine ?? null} className="@max-[100px]:hidden" />
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
    </ContextMenuTrigger>
  );
  return (
    <TabMenu onDuplicate={locked ? undefined : onDuplicate}>
      {hint ? (
        <Tooltip delayDuration={TIP_DELAY}>
          <TooltipTrigger asChild>{tab}</TooltipTrigger>
          <TooltipContent side="bottom">{hint}</TooltipContent>
        </Tooltip>
      ) : (
        tab
      )}
    </TabMenu>
  );
}

type Rename = { title: string; save: (title: string) => void };

/// The title being renamed. Enter or blur saves, Escape cancels, and an empty
/// or unchanged title saves nothing.
function TitleInput({
  title,
  onSave,
  onDone,
}: {
  title: string;
  onSave: (title: string) => void;
  onDone: () => void;
}) {
  // Escape unmounts the field, and a blur fired on the way out would otherwise
  // save what Escape meant to throw away.
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    const next = value?.trim();
    if (next && next !== title) onSave(next);
    onDone();
  };
  const [value, setValue] = useState(title);

  // Sized by an invisible copy of its own text in the same grid cell, so it
  // opens exactly as wide as the title it replaces. `size` alone counts
  // average glyphs and leaves a gap that pushes the row along.
  return (
    <span className="inline-grid min-w-0 grid-cols-[minmax(0,max-content)]">
      <span aria-hidden className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre pr-0.5">
        {value}
      </span>
    <input
      autoFocus
      // Or its default 20-character width props the track open.
      size={1}
      value={value}
      onChange={(e) => setValue(e.currentTarget.value)}
      aria-label="Session title"
      // Caret at the end rather than the whole title selected: a rename is
      // usually an edit, and one stray key would otherwise erase the lot.
      onFocus={(e) => e.currentTarget.setSelectionRange(title.length, title.length)}
      onBlur={() => finish(value)}
      // Or a press in the field starts dragging the tab.
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Typing is kept from the app's bare chords, and Escape from the
        // window: unhandled, it takes a fullscreen window back to windowed.
        // ⌘ chords pass, so ⌘T still opens a tab.
        if (!e.metaKey) e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      className="col-start-1 row-start-1 w-full min-w-0 bg-transparent text-foreground outline-none"
    />
    </span>
  );
}
