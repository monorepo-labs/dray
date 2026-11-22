import type { ReactNode } from "react";
import { Settings } from "lucide-react";

import { SIDEBAR_WIDTH } from "./Sidebar";

/// The app's window, drawn as a picture of it: `AppShell`'s geometry, copied
/// rather than imported, since no code crosses between the two apps.
///
/// A frame with raised sheets on it. One titlebar row spans the whole window,
/// the way a browser's tab strip sits over its pages; the sidebar sits on the
/// frame's own fill under it, and the chat and the right panel are each a
/// card of their own, with the frame showing between.
///
/// Decoration unless `interactive`: a still drawing is `aria-hidden` whole,
/// where the hero's buttons have to be reachable.
export default function Window({
  sidebar,
  tabs,
  headerEnd,
  main,
  crew,
  panel,
  sidebarWidth = SIDEBAR_WIDTH,
  interactive = false,
  className,
}: {
  sidebar: ReactNode;
  /// The tab strip, lined up with the sheet's left edge.
  tabs?: ReactNode;
  /// The strip's far end: the branch, then the PR tab or the panel toggle.
  headerEnd?: ReactNode;
  main: ReactNode;
  /// The crew runs the full height beside the transcript *and* the composer,
  /// inside the chat's sheet. No border between the two: the crew's own
  /// ramped edge is the seam.
  crew?: ReactNode;
  panel?: ReactNode;
  sidebarWidth?: number;
  interactive?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden={!interactive}
      data-app-window
      className={cx(
        "app-frame relative isolate flex flex-col overflow-hidden rounded-xl border border-border text-foreground shadow-window select-none",
        className,
      )}
    >
      {/* Over the sheet, so the lit tab covers the ring's top row and runs
          down into it. */}
      <header className="relative z-30 flex h-(--titlebar-h) shrink-0 items-center pr-3">
        {/* Over the sidebar: the traffic lights, the toggle beside them, and
            the gear at the sidebar's far end. */}
        <div className="flex shrink-0 items-center" style={{ width: sidebarWidth }}>
          <TrafficLights className="w-[78px] pl-[19px]" />
          <span className="grid size-7 place-items-center opacity-80">
            <PanelLeftIcon className="size-4.5" />
          </span>
          <span className="ml-auto mr-2 grid size-7 place-items-center opacity-80">
            <Settings className="size-4" />
          </span>
        </div>
        {/* `-ml-1 pl-[3px]` puts the first tab's border in the column the
            sheet's ring takes, just outside the sheet's left edge. */}
        <div role="tablist" className="-ml-1 flex min-w-0 flex-1 items-center gap-0.5 self-stretch overflow-hidden pr-1 pl-[3px]">
          {tabs}
        </div>
        {headerEnd && <div className="flex shrink-0 items-center gap-3 pl-3">{headerEnd}</div>}
      </header>

      <div className="flex min-h-0 flex-1 pr-2 pb-2">
        <div data-sidebar className="flex shrink-0">
          {sidebar}
        </div>
        <div className="flex min-w-0 flex-1 gap-1.5">
          {/* `min-w-0` is load-bearing: without it a wide row in the
              transcript sets the flex item's floor and pushes the sidebar
              off-screen. */}
          <Sheet className="flex-1" main>
            <div className="flex min-w-0 flex-1 flex-col">{main}</div>
            {crew}
          </Sheet>
          {panel && <Sheet className="shrink-0">{panel}</Sheet>}
        </div>
      </div>
    </div>
  );
}

/// A raised card on the frame: an 8px corner, a ring and the app's drops as
/// boxes of their own over it (`sheet-glow`, `sheet-foot`), its contents
/// clipped to that radius. The main one squares its top-left corner under a
/// lit first tab.
function Sheet({ children, className, main = false }: { children: ReactNode; className?: string; main?: boolean }) {
  return (
    <div className={cx("relative flex min-h-0 min-w-0", className)} data-main-sheet={main ? "" : undefined}>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 z-21 rounded-[8px] rounded-tl-(--sheet-tl,8px) shadow-[var(--sheet-ring,0_0_0_1px_var(--color-hairline))]"
      />
      <span aria-hidden className="sheet-glow" />
      <span aria-hidden className="sheet-foot" />
      <div className="app-sheet flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-[8px] rounded-tl-(--sheet-tl,8px)">
        {children}
      </div>
    </div>
  );
}

/// The three macOS window controls, which float over the app's own header under
/// `titleBarStyle: Overlay`.
export function TrafficLights({ className }: { className?: string }) {
  return (
    <div className={cx("flex items-center gap-2", className)}>
      {["#ff5f57", "#febc2e", "#28c840"].map((fill) => (
        <span key={fill} className="size-3 rounded-full" style={{ backgroundColor: fill }} />
      ))}
    </div>
  );
}

/// A rounded rectangle with its left column filled — the sidebar toggle, drawn
/// after VS Code's. The fill is a plain rect clipped to the rounded outline, so
/// its corners follow the border's arc instead of squaring off.
export function PanelLeftIcon({
  className,
  mirrored = false,
}: {
  className?: string;
  /// The right panel's toggle is the same glyph flipped.
  mirrored?: boolean;
}) {
  const id = mirrored ? "dray-panel-right" : "dray-panel-left";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden
      className={cx(className, mirrored && "-scale-x-100")}
    >
      <clipPath id={id}>
        <rect x="3" y="5" width="18" height="14" rx="2.5" />
      </clipPath>
      <rect
        x="3"
        y="5"
        width="6.5"
        height="14"
        fill="currentColor"
        stroke="none"
        clipPath={`url(#${id})`}
      />
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
    </svg>
  );
}

/// Class joiner. The app's `cn` folds conflicting Tailwind classes; nothing
/// here overrides a copied class, so plain concatenation is the whole job.
export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}
