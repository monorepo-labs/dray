import type { ReactNode } from "react";
import { Settings } from "lucide-react";

/// The app's window frame, drawn as a picture of it. Sidebar, main column and
/// an optional right panel, with the 40px titlebar strip running across all of
/// them — the app's `AppShell` geometry, copied rather than imported, since no
/// code crosses between the two apps.
///
/// Every part of this is decoration: nothing here is interactive and the whole
/// frame is `aria-hidden`.
export default function Window({
  sidebar,
  header,
  main,
  crew,
  panel,
  className,
}: {
  sidebar: ReactNode;
  /// The chat column's titlebar row. Spans the crew too, which is why it sits
  /// above the row holding both rather than inside the chat column.
  header?: ReactNode;
  main: ReactNode;
  /// The crew runs the full height beside the transcript *and* the composer, so
  /// its rows get that band too rather than stopping short of it at a line
  /// nothing else on screen is drawn to. No second border between the two: the
  /// crew's own ramped edge is the seam.
  crew?: ReactNode;
  panel?: ReactNode;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cx(
        "flex overflow-hidden rounded-xl border border-border bg-background shadow-window select-none",
        className,
      )}
    >
      {sidebar}
      {/* `min-w-0` is load-bearing: without it a wide row in the transcript sets
          the flex item's floor and pushes the sidebar off-screen. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {header}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">{main}</div>
          {crew}
        </div>
      </div>
      {panel}
    </div>
  );
}

/// The three macOS window controls, which float over the app's own header under
/// `titleBarStyle: Overlay` — so they live in the sidebar's titlebar strip.
export function TrafficLights({ className }: { className?: string }) {
  return (
    <div className={cx("flex items-center gap-2", className)}>
      {["#ff5f57", "#febc2e", "#28c840"].map((fill) => (
        <span
          key={fill}
          className="size-3 rounded-full"
          style={{ backgroundColor: fill }}
        />
      ))}
    </div>
  );
}

/// The gear and the sidebar toggle, at the strip's right end where they clear
/// the traffic lights. Held back at rest — they are chrome, not content.
export function TitlebarIcons({ className }: { className?: string }) {
  return (
    <div className={cx("flex items-center gap-0.5 opacity-80", className)}>
      <span className="grid size-7 place-items-center">
        <Settings className="size-4" />
      </span>
      <span className="grid size-7 place-items-center">
        <PanelLeftIcon className="size-4.5" />
      </span>
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
