import { X } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";

import { DropZone } from "@/components/SplitView";
import { Button } from "@/components/ui/button";
import { setDropping } from "@/lib/browser";
import { useOpenFiles, useOpenFilesWatcher } from "@/hooks/useOpenFiles";
import { Sheet } from "@/components/layout/AppShell";
import {
  removeSplit,
  setSplitWeights,
  SPLIT_CARD,
  SPLIT_HOST,
  usePaneHead,
  useSplitDrag,
  useSplitGroups,
  useSplitPanes,
  useSplitWeight,
} from "@/lib/splitPanes";
import { cn } from "@/lib/utils";
import type { TabKey } from "@/lib/tabOrder";

const FileViewer = lazy(() => import("@/components/files/FileViewer"));

/// The narrowest a drag between two cards leaves either.
const CARD_MIN = 200;

/// The panes of a session's split groups, each a card right of the main one.
/// Only the lit group's are drawn; the rest hide rather than unmount, so a
/// pane keeps its scroll. Equal widths until the gaps between are dragged,
/// and the drop that would make one too narrow is refused.
export default function SplitPanes({
  sessionId,
  body,
}: {
  /// The row's session, whose groups these are.
  sessionId: string | null;
  /// What a pane draws, by its tab's key; `shown` while its group is lit.
  body: (key: TabKey, shown: boolean) => React.ReactNode;
}) {
  const groups = useSplitGroups(sessionId);
  const lit = useSplitPanes(sessionId);
  const drag = useSplitDrag();
  const hint = sessionId && drag?.sessionId === sessionId ? drag.label : null;
  useEffect(() => {
    setDropping(!!hint);
    return () => setDropping(false);
  }, [hint]);
  return (
    <>
      {sessionId &&
        groups
          .flatMap((g) => g.slice(1))
          .map((key) => (
            <Pane key={key} sessionId={sessionId} paneKey={key} shown={lit.includes(key)} body={body} />
          ))}
      {hint && (
        // The column the drop makes: the last of `lit.length + 2` equal ones.
        <div
          className="pointer-events-none absolute inset-y-0 right-0 z-30"
          style={{ width: `${100 / (lit.length + 2)}%` }}
        >
          <DropZone region="center" label={hint} />
        </div>
      )}
    </>
  );
}

function Pane({
  sessionId,
  paneKey,
  shown,
  body,
}: {
  sessionId: string;
  paneKey: TabKey;
  shown: boolean;
  body: (key: TabKey, shown: boolean) => React.ReactNode;
}) {
  const grow = useSplitWeight(sessionId, paneKey);
  return (
    <div
      className={cn("flex min-w-0 flex-1", !shown && "hidden")}
      style={{ flexGrow: grow }}
      {...{ [SPLIT_CARD]: paneKey }}
    >
      <Gap sessionId={sessionId} paneKey={paneKey} />
      <Sheet className="flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* A page closes from its own URL bar. */}
          {!paneKey.startsWith("page:") && (
            <PaneHeader sessionId={sessionId} paneKey={paneKey} onClose={() => removeSplit(sessionId, paneKey)} />
          )}
          <div className="flex min-h-0 flex-1 flex-col">
            <Suspense fallback={null}>{body(paneKey, shown)}</Suspense>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

/// The frame between a card and the one left of it, dragged to trade width
/// between the two. Every card on screen is set to its measured width first,
/// so the rest hold still and keep their shares as the window resizes.
function Gap({ sessionId, paneKey }: { sessionId: string; paneKey: TabKey }) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const host = e.currentTarget.closest(`[${SPLIT_HOST}]`);
    const cards = [...(host?.querySelectorAll<HTMLElement>(`[${SPLIT_CARD}]`) ?? [])].filter(
      (card) => card.offsetWidth > 0,
    );
    const at = cards.findIndex((card) => card.getAttribute(SPLIT_CARD) === paneKey);
    if (at < 1) return;
    e.preventDefault();
    const keyOf = (card: HTMLElement) => card.getAttribute(SPLIT_CARD)!;
    const widths = cards.map((card) => card.getBoundingClientRect().width);
    setSplitWeights(sessionId, cards.map((card, i) => [keyOf(card), widths[i]]));
    const [left, right] = [keyOf(cards[at - 1]), paneKey];
    const pair = widths[at - 1] + widths[at];
    const x0 = e.clientX;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const l = Math.min(Math.max(widths[at - 1] + ev.clientX - x0, CARD_MIN), pair - CARD_MIN);
      setSplitWeights(sessionId, [
        [left, l],
        [right, pair - l],
      ]);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };
  return (
    <div className="relative w-1.5 shrink-0 bg-surface-frame">
      {/* Wider than the gap it sits in, so it is not a 6px target. */}
      <div onPointerDown={start} className="absolute inset-y-0 -inset-x-1 z-30 cursor-col-resize" />
    </div>
  );
}

function PaneHeader({ sessionId, paneKey, onClose }: { sessionId: string; paneKey: TabKey; onClose: () => void }) {
  const head = usePaneHead(sessionId, paneKey);
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3 text-ui text-muted-foreground">
      {head?.icon}
      <span className="min-w-0 truncate">{head?.label ?? ""}</span>
      <Button variant="ghost" size="icon-xs" className="ml-auto shrink-0" aria-label="Close pane" onClick={onClose}>
        <X />
      </Button>
    </div>
  );
}

/// One of the session's open files, read from its own store: the tab is only
/// left out of the row, so the file stays the session's. Watched under the
/// pane's own scope, since the Files view may not be mounted to watch it.
export function SplitFile({ sessionId, path }: { sessionId: string; path: string }) {
  const file = useOpenFiles(sessionId).open.find((f) => f.path === path) ?? null;
  useOpenFilesWatcher(sessionId, `filepane:${path}`, path);
  // Closed from elsewhere: nothing left to show.
  useEffect(() => {
    if (!file) removeSplit(sessionId, `file:${path}`);
  }, [file, sessionId, path]);
  return <FileViewer file={file} />;
}
