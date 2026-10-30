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
        "app-frame relative flex flex-col overflow-hidden rounded-xl border border-border shadow-window select-none",
        className,
      )}
    >
      <header className="flex h-(--titlebar-h) shrink-0 items-center pr-3">
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
        <div className="flex min-w-0 flex-1 items-center gap-0.5 self-stretch overflow-hidden">
          {tabs}
        </div>
        {headerEnd && <div className="flex shrink-0 items-center gap-3 pl-3">{headerEnd}</div>}
      </header>

      <div className="flex min-h-0 flex-1 pr-2 pb-2">
        {sidebar}
        <div className="flex min-w-0 flex-1 gap-1.5">
          {/* `min-w-0` is load-bearing: without it a wide row in the
              transcript sets the flex item's floor and pushes the sidebar
              off-screen. */}
          <Sheet className="flex-1">
            <div className="flex min-w-0 flex-1 flex-col">{main}</div>
            {crew}
          </Sheet>
          {panel && <Sheet className="shrink-0">{panel}</Sheet>}
        </div>
      </div>
    </div>
  );
}

/// A raised card on the frame: an 8px corner, a hairline ring, its contents
/// clipped to that radius.
function Sheet({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "app-sheet relative flex min-h-0 min-w-0 overflow-hidden rounded-[8px] shadow-[0_0_0_1px_var(--color-hairline)]",
        className,
      )}
    >
      {children}
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
