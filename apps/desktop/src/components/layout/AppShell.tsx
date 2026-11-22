import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { DROP_ATTR } from "@/lib/dragSession";
import { cn } from "@/lib/utils";
import { EMPTY_VIEW } from "@/lib/groups";
import { SPLIT_CARD, SPLIT_HOST } from "@/lib/splitPanes";

type AppShellProps = {
  sidebar: ReactNode;
  /// The sidebar is drawn. Shut, a strip of the frame still holds the sheet
  /// off the window's left edge.
  sidebarOpen?: boolean;
  /// With the sidebar shut on a tall page, how far in from the leftmost card's
  /// edge the header's controls reach, as a CSS length. That card drops below
  /// them and a lit tab spans the rest of its top, as in a task view.
  notch?: string;
  /// The sheet reaches up behind the header rather than starting under it —
  /// for pages with no tabs to sit in the strip. The header floats over the
  /// sheet's top, and the sheet's contents keep their place below it.
  tall?: boolean;
  header?: ReactNode;
  footer: ReactNode;
  /// Right-hand inspector, when open. Sits outside the chat column so the
  /// composer stays scoped to the conversation rather than spanning both.
  panel?: ReactNode;
  /// Draws the panel between the sidebar and the chat column instead of at the
  /// window's right edge.
  panelLeft?: boolean;
  /// The panel is open. It stays mounted while shut, so its card has to be
  /// told rather than read off the element.
  panelOpen?: boolean;
  /// The crew — the sessions this conversation started — when it has any. Inside
  /// the main column so it comes and goes with the view tabs, outside the chat
  /// column for the panel's reason: a composer spanning a list of other
  /// conversations does not say which one it talks to.
  crew?: ReactNode;
  /// The window has no room for the crew beside the chat, so it is drawn
  /// between the transcript and the composer instead.
  crewStacked?: boolean;
  /// Holds the composer in the upper middle of the window and drops the
  /// transcript pane. The empty state has no transcript to anchor the composer
  /// against, so pinning it to the bottom leaves the one usable control as far
  /// from the eye as the window allows. `children` is not rendered in this state.
  centered?: boolean;
  /// Drawn over the centered column — the drop zone, since a sidebar row let
  /// go on the empty state opens the session whole and the zone has to say so
  /// where the pointer is.
  overlay?: ReactNode;
  /// Split panes, cards right of the main one at full height, so the
  /// composer stays under the view it sends from. Draws its own cards.
  beside?: ReactNode;
  /// The main card's place in a lit split: its tab's key, its share of the
  /// width (which dragging a gap beside it moves), its CSS `order` among the
  /// panes, and its floor where it is the chat.
  mainCard?: { key: string; grow: number; order: number; minWidth?: number } | null;
  children: ReactNode;
};

/// Owns every bit of app geometry: the viewport lock, which panes scroll, and where
/// the composer sits. Panes below this get height from their parent and never set
/// their own margins, so there is one place to change the layout.
export default function AppShell({
  sidebar,
  sidebarOpen = true,
  notch,
  tall: pageTall = false,
  header,
  footer,
  panel,
  panelLeft = false,
  panelOpen = false,
  crew,
  crewStacked = false,
  centered = false,
  overlay,
  beside,
  mainCard,
  children,
}: AppShellProps) {
  // A tall page with the sidebar shut sits under the header as a task view
  // does, every card and the strip above them together, so nothing moves
  // twice on the way between; its leftmost card wears the page's lit tab.
  const notched = pageTall && !sidebarOpen && !!notch;
  const tall = pageTall && !notched;
  const pageTab = (leftmost: boolean) => (notched && leftmost ? notch : undefined);
  // A card of its own beside the sheet, with the frame showing between. Kept
  // mounted while shut, since the pane hides rather than unmounts.
  const gap = <div className="w-1.5 shrink-0 bg-surface-frame" />;
  const panelCard = panel && (
    <div className={cn("flex shrink-0", !panelOpen && "hidden")}>
      {!panelLeft && gap}
      <Sheet tall={tall} notch={pageTab(panelLeft)}>
        {panel}
      </Sheet>
      {panelLeft && gap}
    </div>
  );
  return (
    // The header spans the window and everything else sits under it, the way a
    // browser's tab strip sits over its pages.
    // `data-shell` bounds App.css's first-tab joins to this shell: asked of
    // the whole document, Settings' sheet took the hidden task view's corner.
    <div className="relative flex h-full w-full flex-col overflow-hidden" data-shell="">
      {/* Always floating, so the sheet's top can glide between under the
          header and behind it; the strip above the sheet is the header's fill. */}
      <div className="absolute inset-x-0 top-0 z-30">{header}</div>
      {/* Not `overflow-hidden`: the sheet's ring and shadow sit just outside it,
          and the top edge would be cut away. The window clips already. */}
      <div className="flex min-h-0 flex-1">
        {/* On the titlebar's own fill, so header and sidebar are one frame
            and the sheet beside them is the only thing raised. */}
        <div
          className={cn(
            "flex shrink-0 bg-surface-frame",
            !sidebarOpen && "w-2",
            // The header floats over its top, so it starts below the header.
            "pt-(--titlebar-h)",
            // The frame is the page's own colour in light now, so the veil
            // takes Default light's weight there: #ededed on white. A palette
            // may name the fill outright with `--sidebar-selected`.
            "not-dark:[--sidebar-accent:var(--sidebar-selected,color-mix(in_oklab,var(--foreground)_12%,transparent))]",
            // Keycaps too: their muted veil was tuned against the bare page.
            "not-dark:[&_[data-slot=kbd]]:bg-foreground/13",
          )}
        >
          {sidebar}
        </div>
        {/* The frame runs on round the sheet's foot and right side too, as
            strips of the same fill: the sheet is glass, so a fill behind it
            would darken it as well. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className={cn(
              "shrink-0 bg-surface-frame transition-[height]",
              // The timing is the destination's: rising to a page quickly,
              // settling into a task a little slower.
              tall ? "h-2 duration-125 ease-in" : "h-(--titlebar-h) duration-200 ease-out",
            )}
          />
          <div className="flex min-h-0 min-w-0 flex-1">
            {panelLeft && panelCard}
            {/* The main card and its panes, measured together for room. */}
            <div className="relative flex min-h-0 min-w-0 flex-1" {...{ [SPLIT_HOST]: "" }}>
            <Sheet
              className="flex-1"
              tall={tall}
              notch={pageTab(!(panelLeft && panelOpen) && (!mainCard || mainCard.order === 0))}
              style={
                mainCard
                  ? { flexGrow: mainCard.grow, order: mainCard.order, minWidth: mainCard.minWidth }
                  : undefined
              }
              {...(mainCard && { [SPLIT_CARD]: mainCard.key })}
              data-main-sheet=""
              // Leftmost, so the first view tab sits on its edge (App.css).
              {...(!(panelLeft && panelOpen) && (!mainCard || mainCard.order === 0) && { "data-flush-left": "" })}
            >
        {/* `min-w-0` is load-bearing: without it a wide code block in the transcript
          sets the flex item's floor and pushes the sidebar off-screen. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {centered ? (
            // Held below the top rather than centered. Centering moves the whole
            // block every time the textarea grows a line, so the wordmark and the
            // toolbar drift upwards as you type; a fixed offset keeps everything
            // above the input still and lets the box grow downwards alone. The
            // offset is a proportion of the window rather than a fixed inset, which
            // would read as top-aligned on a tall window and off-centre on a short
            // one. `overflow-y-auto` only ever engages on a window too short to
            // hold the composer at its full height — the box caps itself well
            // before that at the default size.
            <div
              className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto"
              {...{ [DROP_ATTR]: EMPTY_VIEW }}
            >
              {/* `children` is deliberately dropped: there is no transcript to
                show, and the composer is the whole state. */}
              <div className="w-full shrink-0 pt-[13vh]">{footer}</div>
              {overlay}
            </div>
          ) : (
            // The crew runs the full height beside both, so its rows get the
            // composer's band too rather than stopping short of it at a line
            // nothing else on screen is drawn to.
            <div className="relative flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                {/* `flex flex-col` so the view tabs' bodies, which size themselves
                  with `flex-1` the way the right panel's do, have a column to
                  grow in. */}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  {children}
                </div>
                {crewStacked && crew}
                <div className="shrink-0">{footer}</div>
              </div>
              {!crewStacked && crew}
            </div>
          )}
        </div>
            </Sheet>
            {beside}
            </div>
            {!panelLeft && panelCard}
          </div>
          <div className="h-2 shrink-0 bg-surface-frame" />
        </div>
        <div className="w-2 shrink-0 bg-surface-frame" />
      </div>
    </div>
  );
}

/// A raised card on the frame: an 8px-round ring and shadow, its contents
/// clipped to that radius, and the frame's fill bending round each corner.
///
/// Both halves of the corner are needed. The clip is what rounds an opaque
/// child — a page-coloured URL row drew square corners straight through a
/// scrim alone, since 7% of black over a dark row is nothing. The scrim is what
/// paints the corner's outside: the clip leaves bare glass there, lighter than
/// the frame around it, and nothing can make glass darker but a fill.
export function Sheet({
  className,
  tall = false,
  notch,
  style,
  children,
  ...attrs
}: {
  className?: string;
  style?: React.CSSProperties;
  /// `data-*` attributes, put on the card's outer box.
  [attr: `data-${string}`]: string;
  /// Reaching up behind the header: its contents start below it all the same.
  tall?: boolean;
  /// Draws a lit tab over the whole top from this far in, as a CSS length:
  /// a page's stand-in for a task view's first tab (`page-tab` in App.css).
  notch?: string;
  children: ReactNode;
}) {
  const corner = "pointer-events-none absolute z-20 size-2";
  // A card too narrow to carry the page's tab past both its corners keeps its
  // own round ones instead. Read off the tab, which is laid out either way.
  const box = useRef<HTMLDivElement>(null);
  const [roomy, setRoomy] = useState(true);
  useLayoutEffect(() => {
    const tab = box.current?.querySelector<HTMLElement>(".page-tab");
    if (!tab) return;
    const ro = new ResizeObserver(() => setRoomy(tab.offsetWidth >= 2 * 10 + 8));
    ro.observe(tab);
    return () => ro.disconnect();
  }, [notch]);
  return (
    <div
      ref={box}
      className={cn("relative flex min-h-0 min-w-0", className)}
      style={notch ? ({ ...style, "--notch-w": notch } as React.CSSProperties) : style}
      {...(notch && roomy && { "data-notch": "" })}
      {...attrs}
    >
      {notch && <span aria-hidden data-lit="" className="tab-strip page-tab" />}
      {/* Its own box over the panes rather than a shadow on them, which would
          clip at their edge. Inert, so every click passes through. One above
          the corners, whose frame fill otherwise covers the ring's arc. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 z-21 rounded-[8px] rounded-tl-[var(--sheet-tl,8px)] rounded-tr-[var(--sheet-tr,8px)] shadow-[var(--sheet-ring,var(--shadow-sheet))]"
      />
      <span aria-hidden className="sheet-glow" />
      <span aria-hidden className="sheet-foot" />
      {/* Sized off `--sheet-tl` in App.css: the first tab's drag grows it. */}
      <span aria-hidden data-sheet-tl="" className={cn(corner, "top-0 left-0")} />
      <span aria-hidden data-sheet-tr="" className={cn(corner, "top-0 right-0")} />
      <span aria-hidden className={cn(corner, "bottom-0 left-0 bg-[radial-gradient(circle_at_100%_0%,transparent_8px,var(--surface-frame)_8.5px)]")} />
      <span aria-hidden className={cn(corner, "right-0 bottom-0 bg-[radial-gradient(circle_at_0%_0%,transparent_8px,var(--surface-frame)_8.5px)]")} />
      <div
        className={cn(
          // Grows by what the sheet rose, so the contents hold still.
          "flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-[8px] rounded-tl-[var(--sheet-tl,8px)] rounded-tr-[var(--sheet-tr,8px)] bg-(--surface-sheet) transition-[padding]",
          tall ? "pt-[calc(var(--titlebar-h)-0.5rem)] duration-125 ease-in" : "duration-200 ease-out",
        )}
      >
        {children}
      </div>
    </div>
  );
}
