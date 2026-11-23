import type { ReactNode } from "react";
import { FolderGit2, Plus } from "lucide-react";

import { PanelLeftIcon, cx } from "./Window";

/// Heroicons' 16px solid chat mark, which the app's tab strip draws: a page's
/// favicon is a filled mark, so the chat beside it is too.
export function ChatIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={cx("shrink-0 text-muted-foreground", className)}>
      <path
        fillRule="evenodd"
        d="M1 8c0-3.43 3.262-6 7-6s7 2.57 7 6-3.262 6-7 6c-.423 0-.838-.032-1.241-.094-.9.574-1.941.948-3.06 1.06a.75.75 0 0 1-.713-1.14c.232-.378.395-.804.469-1.26C1.979 11.486 1 9.86 1 8Z"
      />
    </svg>
  );
}

/// One tab. In the titlebar strip (`strip`) it is a browser's: flat on the
/// frame, and lit, a piece of the sheet running down into it (`tab-strip` in
/// globals.css). Off the strip, the PR toggle's, the active one is raised as
/// the segmented control's thumb is.
export function ItemTab({
  icon,
  label,
  active = false,
  plain = false,
  strip = false,
  fixed = false,
  trailing,
  onClick,
}: {
  icon?: ReactNode;
  label: ReactNode;
  active?: boolean;
  plain?: boolean;
  /// A browser's tab in the titlebar strip, even alone, as the app draws one.
  strip?: boolean;
  /// Sized by its own label rather than by the row.
  fixed?: boolean;
  /// After the label: the server mark on a task running on another machine.
  trailing?: ReactNode;
  /// Makes the tab a button. Hover lifts an inactive label to full strength,
  /// as the app's strip does.
  onClick?: () => void;
}) {
  const Tab = onClick ? "button" : "span";
  const browserTab = strip && !plain;
  return (
    <Tab
      {...(onClick && { type: "button" as const, onClick, "aria-current": active || undefined })}
      data-lit={browserTab && active ? "" : undefined}
      className={cx(
        "relative flex items-center gap-1.5 px-2 text-left text-ui",
        // Down to the strip's floor, so the lit one meets the sheet.
        browserTab ? "tab-strip h-8.5 self-end" : "h-7 rounded-md",
        onClick && "transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        fixed || plain ? "shrink-0" : cx("min-w-0 basis-44", active ? "min-w-44" : "min-w-[100px]"),
        plain || (browserTab && active)
          ? "text-foreground"
          : active
            ? "bg-surface-thumb text-foreground ring-1 ring-hairline"
            : cx("text-muted-foreground", onClick && "hover:text-foreground"),
      )}
    >
      {icon}
      {/* Faded rather than ellipsed, so a cut title still reads as a word. */}
      <span
        className={cx(
          "min-w-0 flex-1 overflow-hidden whitespace-nowrap",
          !fixed && !plain && "mask-[linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]",
        )}
      >
        {label}
      </span>
      {trailing}
    </Tab>
  );
}

/// The `+` after the last tab, where a browser keeps it.
export function AddTab() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground">
      <Plus className="size-3.5" />
    </span>
  );
}

/// The session's branch at the strip's far end. A Dray worktree's branch is
/// `worktree-<name>`; the mark already says worktree, so the name is drawn bare.
export function BranchButton({ name }: { name: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-ui text-muted-foreground">
      <FolderGit2 className="size-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/// The panel toggle, where the session has no pull request to stand in for it.
export function PanelToggle() {
  return (
    <span className="grid size-7 shrink-0 place-items-center opacity-80">
      <PanelLeftIcon className="size-4.5" mirrored />
    </span>
  );
}
