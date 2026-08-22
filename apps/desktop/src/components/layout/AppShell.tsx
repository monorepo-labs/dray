import type { ReactNode } from "react";

type AppShellProps = {
  sidebar: ReactNode;
  header?: ReactNode;
  footer: ReactNode;
  /// Right-hand inspector, when open. Sits outside the chat column so the
  /// composer stays scoped to the conversation rather than spanning both.
  panel?: ReactNode;
  /// Holds the composer in the upper middle of the window and drops the
  /// transcript pane. The empty state has no transcript to anchor the composer
  /// against, so pinning it to the bottom leaves the one usable control as far
  /// from the eye as the window allows. `children` is not rendered in this state.
  centered?: boolean;
  children: ReactNode;
};

/// Owns every bit of app geometry: the viewport lock, which panes scroll, and where
/// the composer sits. Panes below this get height from their parent and never set
/// their own margins, so there is one place to change the layout.
export default function AppShell({
  sidebar,
  header,
  footer,
  panel,
  centered = false,
  children,
}: AppShellProps) {
  return (
    <div className="flex h-full w-full overflow-hidden">
      {sidebar}

      {/* `min-w-0` is load-bearing: without it a wide code block in the transcript
          sets the flex item's floor and pushes the sidebar off-screen. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {header}
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
          <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto">
            {/* `children` is deliberately dropped: there is no transcript to
                show, and the composer is the whole state. */}
            <div className="w-full shrink-0 pt-[13vh]">{footer}</div>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            <div className="shrink-0">{footer}</div>
          </>
        )}
      </div>

      {panel}
    </div>
  );
}
