import { useEffect, useState } from "react";
import { X } from "lucide-react";

import Chat from "@/components/Chat";
import GitBranchIcon from "@/components/icons/GitBranchIcon";
import { Button } from "@/components/ui/button";
import ShortcutKeys from "@/components/ShortcutKeys";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHasDraft } from "@/hooks/useDraft";
import type { PaneState } from "@/hooks/useSessions";
import { DROP_ATTR, useSessionDrag } from "@/lib/dragSession";
import { basename } from "@/lib/format";
import { dropLabel, type Region, type SplitGroup } from "@/lib/groups";
import { IS_MAC } from "@/lib/platform";
import { sessionBranch } from "@/lib/pr";
import { cn } from "@/lib/utils";
import type { SessionIndexItem } from "@/types/events";

type SplitViewProps = {
  /// Left to right, each top to bottom.
  columns: SessionIndexItem[][];
  /// The pane the main header, right panel and composer serve.
  focusedId: string | null;
  paneState: (sessionId: string) => PaneState;
  /// The active space's groups, for the drop zones' sentences.
  groups: SplitGroup[];
  onFocus: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  /// Whether the view is on screen, for the focused pane's own chords.
  active: boolean;
  chat: Pick<
    React.ComponentProps<typeof Chat>,
    | "onOpenSubagent"
    | "onOpenSession"
    | "onOpenSubagentPanel"
    | "onRespondPermission"
    | "onAnswerQuestions"
  >;
};

/// Up to four transcripts in columns. One composer serves the focused pane —
/// the selected session — so a click anywhere in a pane focuses it, and the
/// pane header is what says which one that is.
export default function SplitView({
  columns,
  focusedId,
  paneState,
  groups,
  onFocus,
  onClose,
  active,
  chat,
}: SplitViewProps) {
  const drag = useSessionDrag();
  const metaHeld = useMetaHeld();
  // Composing into the focused pane, so every other transcript gives way. The
  // draft store is read here directly rather than threaded down from the
  // composer — it is module-level and keyed by session, which is the whole
  // reason it exists. The *emptiness* alone, never the text: this component
  // holds every mounted transcript, so subscribing to the string would rerender
  // all four on every keystroke.
  const composing = useHasDraft(focusedId);
  // Grid order, which is what ⌘1–4 count in.
  const numbers = new Map(columns.flat().map((item, i) => [item.sessionId, i + 1]));
  return (
    // A top border, since the main header draws none of its own and the pane
    // headers under it would otherwise read as a second line of the same row.
    <div className="flex h-full min-h-0 border-t border-hairline">
      {columns.map((column, ci) => {
        // A left or right drop makes a column, so its preview is drawn on the
        // column at full height rather than inside the pane the pointer is on
        // — in a stacked column that box would be half the height of what
        // the drop makes.
        const hintFor = (item: SessionIndexItem) =>
          drag && drag.over?.sessionId === item.sessionId
            ? {
                region: drag.over.region,
                label: dropLabel(groups, item.sessionId, drag.sessionId, drag.over.region),
              }
            : null;
        const sideways = column
          .map(hintFor)
          .find((h) => h && (h.region === "left" || h.region === "right"));
        return (
        <div
          key={column.map((i) => i.sessionId).join()}
          className={cn(
            "relative flex min-w-0 flex-1 flex-col",
            ci > 0 && "border-l border-hairline-strong",
          )}
        >
          {sideways && <DropZone region={sideways.region} label={sideways.label} />}
          {column.map((item, ri) => {
            const focused = item.sessionId === focusedId;
            const hint = hintFor(item);
            return (
              <div
                key={item.sessionId}
                {...{ [DROP_ATTR]: item.sessionId }}
                // Pointerdown bubbles here before the click it precedes, so a
                // button inside the transcript acts on an already-focused pane.
                // Close stops it: closing a pane must not first make it the one
                // the composer serves.
                onPointerDown={() => !focused && onFocus(item.sessionId)}
                // Keyboard focus entering a pane is the same claim: Tab onto
                // a link here, then Enter, must act through this session.
                // React's onFocus bubbles, so any control inside answers.
                onFocus={() => !focused && onFocus(item.sessionId)}
                className={cn(
                  "relative flex min-h-0 flex-1 flex-col",
                  ri > 0 && "border-t border-hairline-strong",
                )}
              >
                <PaneHeader
                  item={item}
                  focused={focused}
                  number={numbers.get(item.sessionId) ?? 0}
                  showNumber={metaHeld && !focused}
                  onClose={() => onClose(item.sessionId)}
                />
                {/* Dimmed rather than veiled: a scrim is one more element to
                    keep in step with the palette, and opacity recedes the
                    transcript against whatever is behind it. The header keeps
                    full strength, since it is what names the pane. */}
                <div
                  className={cn(
                    "min-h-0 flex-1 transition-opacity duration-150 ease-out",
                    composing && !focused && "opacity-35",
                  )}
                >
                  <Chat
                    {...paneState(item.sessionId)}
                    {...chat}
                    // Narrowest the transcript gets, so the rail always gives way.
                    crowded
                    // The rail only where the pane has the column's whole
                    // height: halved, it sits over the text.
                    rail={column.length === 1}
                    active={active && focused}
                  />
                </div>
                {hint && hint.region !== "left" && hint.region !== "right" && (
                  <DropZone region={hint.region} label={hint.label} />
                )}
              </div>
            );
          })}
        </div>
        );
      })}
    </div>
  );
}

/// The dragged row's title, following the pointer.
export function DragGhost() {
  const drag = useSessionDrag();
  if (!drag) return null;
  return (
    <div
      className="pointer-events-none fixed z-50 max-w-64 truncate rounded-md border border-hairline-strong bg-popover px-2.5 py-1 text-ui text-popover-foreground shadow-md"
      style={{ left: drag.x + 12, top: drag.y + 12 }}
    >
      {drag.title}
    </div>
  );
}

/// Where the region's pane would go, drawn over the pane the pointer is on.
const REGION_BOX: Record<Region, string> = {
  center: "inset-0",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
};

/// Drawn over a pane while a row is held above it: the space the drop would
/// take, and what letting go does. No label means no room, and nothing is
/// drawn — a zone that lights up and then does nothing is worse than none.
export function DropZone({ region, label }: { region: Region; label: string | null }) {
  if (!label) return null;
  return (
    // Square and flush: the zone is the pane the drop would make, and a pane is
    // a sharp box with no inset. Fill with some opacity and a solid edge — a
    // blur or a dashed rim read as a dialog over the transcript.
    <div
      className={cn(
        "pointer-events-none absolute z-10 flex items-center justify-center border border-ring bg-ring/15 text-ui font-medium text-foreground",
        REGION_BOX[region],
      )}
    >
      {label}
    </div>
  );
}

/// Title, project and branch — the row the main header draws, minus the tabs,
/// with a close beside it. The focused pane's header takes a fill, which is
/// what says where the composer sends.
function PaneHeader({
  item,
  focused,
  number,
  showNumber,
  onClose,
}: {
  item: SessionIndexItem;
  focused: boolean;
  /// This pane's place in ⌘1–4.
  number: number;
  /// The accelerator is held, so the close button gives its slot to the
  /// keycap that reaches this pane — the one moment the number is useful.
  showNumber: boolean;
  onClose: () => void;
}) {
  const branch = sessionBranch(item);
  return (
    <div
      className={cn(
        "relative flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3 text-ui",
        // Softened in the default light palette alone, where the full token
        // reads as darker than the selected sidebar row it is borrowed from.
        focused
          ? "bg-sidebar-accent text-foreground [[data-theme=default][data-mode=light]_&]:bg-sidebar-accent/60"
          : "text-muted-foreground",
      )}
    >
      {/* The mark that says where the composer sends: one solid bar at the
          start of the header, where the eye lands first. */}
      {focused && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground">{basename(item.projectPath)}</span>
        <span aria-hidden className="shrink-0 text-muted-foreground/50">
          /
        </span>
        <span className={cn("truncate", focused && "font-medium")}>{item.title}</span>
      </span>
      {branch && (
        <span className="flex min-w-0 shrink items-center gap-1 text-muted-foreground">
          <GitBranchIcon className="size-3.5 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      )}
      {showNumber ? (
        // The digit alone: ⌘ is the key being held to see this.
        <Kbd className="ml-auto shrink-0">{number}</Kbd>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              // Ghost's hover fill is the muted veil, which the focused
              // header's own fill already is — so there it hovers in
              // foreground instead, or the button never shows a hover at all.
              className={cn(
                "ml-auto shrink-0",
                focused && "hover:bg-foreground/10 dark:hover:bg-foreground/15",
              )}
              aria-label="Close pane"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onClose}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <ShortcutKeys ids={["pane.close"]} />
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/// Whether the platform accelerator is down right now. Cleared on blur as
/// well as keyup: ⌘Tab out of the app loses the keyup, and the keycaps would
/// otherwise stay up until the next press.
function useMetaHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const key = IS_MAC ? "Meta" : "Control";
    const down = (e: KeyboardEvent) => e.key === key && setHeld(true);
    const up = (e: KeyboardEvent) => e.key === key && setHeld(false);
    const clear = () => setHeld(false);
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return held;
}
