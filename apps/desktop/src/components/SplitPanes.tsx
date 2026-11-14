import { X } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { setDropping } from "@/lib/browser";
import { useOpenFiles, useOpenFilesWatcher } from "@/hooks/useOpenFiles";
import { Sheet } from "@/components/layout/AppShell";
import { CHAT_MIN } from "@/components/ResizeHandle";
import {
  membersOf,
  removeSplit,
  setSplitWeights,
  SPLIT_CARD,
  SPLIT_HOST,
  useLitGroup,
  usePaneHead,
  useSplitDrag,
  useSplitGroups,
  useSplitWeight,
} from "@/lib/splitPanes";
import { cn } from "@/lib/utils";
import type { TabKey } from "@/lib/tabOrder";

const FileViewer = lazy(() => import("@/components/files/FileViewer"));

/// The narrowest a drag between two cards leaves either.
const CARD_MIN = 200;

/// The panes of a session's split groups, each a card beside the main one.
/// Only the lit group's are drawn; the rest hide rather than unmount, so a
/// pane keeps its scroll. Cards sit in the group's order by CSS `order`, the
/// main card among them, so a move inside the group moves no DOM: a mounted
/// page or transcript is never torn down for it. Equal widths until the gaps
/// between are dragged, and the drop that would make one too narrow is refused.
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
  const lit = useLitGroup(sessionId);
  const drag = useSplitDrag();
  const hint = sessionId && drag?.sessionId === sessionId && drag.label ? drag : null;
  useEffect(() => {
    setDropping(!!hint);
    return () => setDropping(false);
  }, [hint]);
  const cards = lit?.keys ?? [];
  return (
    <>
      {sessionId &&
        groups.flatMap(membersOf).map((key) => (
          <Pane
            key={key}
            sessionId={sessionId}
            paneKey={key}
            at={cards.indexOf(key)}
            body={body}
          />
        ))}
      {sessionId &&
        cards
          .slice(1)
          .map((right, i) => (
            <Gap key={`${cards[i]}|${right}`} sessionId={sessionId} left={cards[i]} right={right} at={i} />
          ))}
      {hint && (
        // The card the drop makes, at the end it would land: one of
        // `cards + 1` equal columns, or of two for a new group. Past the gap
        // and with a card's corners; the task split's square zone is a pane,
        // not a card.
        <div
          className={cn(
            "pointer-events-none absolute inset-y-0 z-30",
            hint.side === "left" ? "left-0 pr-1.5" : "right-0 pl-1.5",
          )}
          style={{ width: `${100 / (Math.max(cards.length, 1) + 1)}%` }}
        >
          <div className="flex h-full items-center justify-center rounded-[8px] border border-ring bg-ring/15 text-ui font-medium text-foreground">
            {hint.label}
          </div>
        </div>
      )}
    </>
  );
}

/// A card's place among its group's cards and gaps: cards on the even slots,
/// the gap after card `i` on `2i + 1`.
export const cardOrder = (at: number) => 2 * at;

function Pane({
  sessionId,
  paneKey,
  at,
  body,
}: {
  sessionId: string;
  paneKey: TabKey;
  /// Its place in the lit group, or -1 where its group is not lit.
  at: number;
  body: (key: TabKey, shown: boolean) => React.ReactNode;
}) {
  const grow = useSplitWeight(sessionId, paneKey);
  const shown = at >= 0;
  return (
    <div
      className={cn("flex min-w-0 flex-1", !shown && "hidden")}
      style={{
        flexGrow: grow,
        order: cardOrder(at),
        // A task's transcript keeps the chat's floor.
        minWidth: paneKey.startsWith("task:") ? CHAT_MIN : undefined,
      }}
      {...{ [SPLIT_CARD]: paneKey }}
    >
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

/// The frame between two cards, dragged to trade width between them. Every
/// card on screen is set to its measured width first, so the rest hold still
/// and keep their shares as the window resizes. Neither goes under its own
/// `min-width` — a chat's floor — or `CARD_MIN`.
function Gap({ sessionId, left, right, at }: { sessionId: string; left: TabKey; right: TabKey; at: number }) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const host = e.currentTarget.closest(`[${SPLIT_HOST}]`);
    const cards = [...(host?.querySelectorAll<HTMLElement>(`[${SPLIT_CARD}]`) ?? [])].filter(
      (card) => card.offsetWidth > 0,
    );
    const keyOf = (card: HTMLElement) => card.getAttribute(SPLIT_CARD)!;
    const l = cards.find((card) => keyOf(card) === left);
    const r = cards.find((card) => keyOf(card) === right);
    if (!l || !r) return;
    e.preventDefault();
    setSplitWeights(sessionId, cards.map((card) => [keyOf(card), card.getBoundingClientRect().width]));
    const floor = (card: HTMLElement) => Math.max(CARD_MIN, parseFloat(getComputedStyle(card).minWidth) || 0);
    const w0 = l.getBoundingClientRect().width;
    const pair = w0 + r.getBoundingClientRect().width;
    const [lo, hi] = [floor(l), pair - floor(r)];
    const x0 = e.clientX;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (lo > hi) return;
      const w = Math.min(Math.max(w0 + ev.clientX - x0, lo), hi);
      setSplitWeights(sessionId, [
        [left, w],
        [right, pair - w],
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
    <div className="relative w-1.5 shrink-0 bg-surface-frame" style={{ order: cardOrder(at) + 1 }}>
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
