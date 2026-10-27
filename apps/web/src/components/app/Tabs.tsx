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

/// One tab of the titlebar strip. The active one is raised out of the darker
/// strip the way a browser's is — the segmented control's thumb, which is
/// that same picture small. A lone chat is a title rather than a tab: nothing
/// beside it to pick between, so no pill to say which is picked.
export function ItemTab({
  icon,
  label,
  active = false,
  plain = false,
  fixed = false,
  onClick,
}: {
  icon?: ReactNode;
  label: ReactNode;
  active?: boolean;
  plain?: boolean;
  /// Sized by its own label rather than by the row.
  fixed?: boolean;
  /// Makes the tab a button. Hover lifts an inactive label to full strength,
  /// as the app's strip does.
  onClick?: () => void;
}) {
  const Tab = onClick ? "button" : "span";
  return (
    <Tab
      {...(onClick && { type: "button" as const, onClick, "aria-current": active || undefined })}
      className={cx(
        "flex h-7 items-center gap-1.5 rounded-md px-2 text-left text-ui",
        onClick && "transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        fixed || plain ? "shrink-0" : cx("min-w-0 basis-44", active ? "min-w-44" : "min-w-[100px]"),
        plain
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
