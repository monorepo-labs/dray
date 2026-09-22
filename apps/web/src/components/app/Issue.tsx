import type { ReactNode } from "react";

import { cx } from "./Window";

/// Linear's own status marks, as the app redraws them: a ring with a pie
/// wedge for progress, a filled tick for done. Colours are Linear's defaults.
export function IssueStateIcon({
  kind,
  className,
}: {
  kind: "unstarted" | "started" | "completed";
  className?: string;
}) {
  const shared = { viewBox: "0 0 14 14", className: cx("size-3.5 shrink-0", className), "aria-hidden": true };

  if (kind === "completed") {
    return (
      <svg {...shared} fill="#5e6ad2">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M7 0C3.13401 0 0 3.13401 0 7C0 10.866 3.13401 14 7 14C10.866 14 14 10.866 14 7C14 3.13401 10.866 0 7 0ZM11.101 5.10104C11.433 4.76909 11.433 4.23091 11.101 3.89896C10.7691 3.56701 10.2309 3.56701 9.89896 3.89896L5.5 8.29792L4.10104 6.89896C3.7691 6.56701 3.2309 6.56701 2.89896 6.89896C2.56701 7.2309 2.56701 7.7691 2.89896 8.10104L4.89896 10.101C5.2309 10.433 5.7691 10.433 6.10104 10.101L11.101 5.10104Z"
        />
      </svg>
    );
  }

  const fill = kind === "started" ? "#f2c94c" : "#e2e2e2";
  return (
    <svg {...shared}>
      <rect x="1" y="1" width="12" height="12" rx="6" stroke={fill} strokeWidth="1.5" fill="none" />
      {kind === "started" && (
        // Half the ring: In Progress. Linear's mark is a filled pie, not a
        // dashed stroke, which at 14px reads as a dotted outline.
        <path d="M 3.5,3.5 L 3.5,0 A 3.5,3.5 0 0,1 3.5,7 z" fill={fill} transform="translate(3.5,3.5)" />
      )}
    </svg>
  );
}

/// The priority bars, always drawn — the slot is what keeps the column
/// straight, and the lit count is the signal.
export function IssuePriorityIcon({ level, className }: { level: 0 | 1 | 2 | 3; className?: string }) {
  const dim = (index: number) => (index <= level ? 1 : 0.25);
  if (level === 0) {
    return (
      <svg viewBox="0 0 16 16" className={cx("size-4 shrink-0 text-muted-foreground/50", className)} fill="currentColor" aria-hidden>
        <rect x="1.5" y="7.25" width="3" height="1.5" rx="0.5" />
        <rect x="6.5" y="7.25" width="3" height="1.5" rx="0.5" />
        <rect x="11.5" y="7.25" width="3" height="1.5" rx="0.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className={cx("size-4 shrink-0 text-muted-foreground", className)} fill="currentColor" aria-hidden>
      <rect x="1.5" y="8" width="3" height="6" rx="1" fillOpacity={dim(1)} />
      <rect x="6.5" y="5" width="3" height="9" rx="1" fillOpacity={dim(2)} />
      <rect x="11.5" y="2" width="3" height="12" rx="1" fillOpacity={dim(3)} />
    </svg>
  );
}

/// One row of the `#` picker: state, identifier, title, priority trailing.
export function IssueRow({
  kind,
  id,
  title,
  priority = 0,
  highlight,
  className,
}: {
  kind: "unstarted" | "started" | "completed";
  id: string;
  title: string;
  priority?: 0 | 1 | 2 | 3;
  /// Classes for the highlight layer under the row — the arrow keys' veil,
  /// its own element so a scene can cut it on and off.
  highlight?: string;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "relative flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-ui text-foreground",
        className,
      )}
    >
      <span className={cx("absolute inset-0 -z-10 rounded-lg bg-veil-strong opacity-0", highlight)} />
      <IssueStateIcon kind={kind} />
      <span className="shrink-0 font-medium tabular-nums">{id}</span>
      <span className="min-w-0 truncate text-muted-foreground">{title}</span>
      <IssuePriorityIcon level={priority} className="ml-auto" />
    </div>
  );
}

/// The picker's list, opening upward off the composer as the app's does
/// with the composer at the foot — bare, since it sits straight on the
/// page. Hung off the composer's own box rather than given a box of its
/// own, so a closed picker leaves nothing empty behind it.
export function IssuePicker({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("absolute inset-x-6 bottom-full z-50 mb-1.5 flex flex-col", className)}>
      {children}
    </div>
  );
}

/// A placed tag in the composer: the app draws an issue as `#` plus its
/// title, filled in the issue accent with the page as ink.
export function IssueChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline whitespace-nowrap rounded-sm bg-accent-issue px-1 align-baseline text-[0.94em] leading-tight text-background",
        className,
      )}
    >
      {children}
    </span>
  );
}
