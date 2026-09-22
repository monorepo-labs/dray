import type { ReactNode } from "react";
import { X } from "lucide-react";
import { GitBranchIcon } from "./Chat";
import { cx } from "./Window";

/// A pane's header in the split grid, as `SplitView` draws it: project, title,
/// branch, and the close cross; the focused one carries a fill and a 2px bar
/// on its left edge.
export function PaneHeader({
  project,
  title,
  branch,
  focused = false,
  className,
}: {
  project: string;
  title: string;
  branch?: string;
  focused?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "relative flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3 text-ui",
        focused ? "bg-sidebar-accent text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {focused && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground">{project}</span>
        <span className="shrink-0 text-muted-foreground/50">/</span>
        <span className={cx("truncate", focused && "font-medium")}>{title}</span>
      </span>
      {branch && (
        <span className="flex min-w-0 shrink items-center gap-1 text-muted-foreground">
          <GitBranchIcon className="size-3.5 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      )}
      <span className="ml-auto grid size-6 shrink-0 place-items-center">
        <X className="size-3.5" />
      </span>
    </div>
  );
}

/// The region a dragged session would land in, and what dropping does.
export function DropZone({
  region,
  label,
  className,
}: {
  region: "right" | "bottom";
  label: string;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "pointer-events-none absolute z-10 flex items-center justify-center border border-ring bg-ring/15 text-ui font-medium text-foreground",
        region === "right" ? "inset-y-0 right-0 w-1/2" : "inset-x-0 bottom-0 h-1/2",
        className,
      )}
    >
      {label}
    </div>
  );
}

/// The row travelling under the cursor.
export function DragGhost({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "pointer-events-none absolute top-0 left-0 z-50 max-w-64 truncate rounded-md border border-hairline-strong bg-popover px-2.5 py-1 text-ui shadow-md",
        className,
      )}
    >
      {children}
    </div>
  );
}
