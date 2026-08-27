import { cn } from "@/lib/utils";
import type { IssuePriority, IssueStateKind } from "@/types/events";

/// Linear's own status and priority marks, redrawn rather than approximated.
///
/// These are the two glyph sets a reader arriving from the tracker already
/// knows by shape — a part-filled ring is progress, three rising bars are
/// priority — and a lucide stand-in for either was a second vocabulary to
/// learn for no gain. Paths taken from Linear's own SVGs.
///
/// Shape comes from the *kind*, which is a fixed six-way vocabulary; the colour
/// is the tracker's where it gave one. A workspace that paints "In Review"
/// green should read green here too, and the kind is what keeps the shape
/// stable while it does.

/// Fallback colours, matching Linear's defaults, for where no state colour is
/// to hand — the issues page's group headers name a *kind*, and the several
/// states folded into one may each carry a different colour of their own.
const KIND_COLOR: Record<IssueStateKind, string> = {
  triage: "#e2a336",
  backlog: "#bec2c8",
  unstarted: "#e2e2e2",
  started: "#f2c94c",
  completed: "#5e6ad2",
  canceled: "#95a2b3",
  other: "#bec2c8",
};

/// How far round the ring is filled. Linear draws progress as a pie wedge
/// inside an outlined circle, and the fraction is the whole of what separates
/// Todo from In Progress from In Review.
const WEDGE: Partial<Record<IssueStateKind, number>> = {
  unstarted: 0,
  triage: 0.25,
  started: 0.5,
  other: 0,
};

/// The wedge path for a fraction of the ring, drawn from the centre.
///
/// Hand-rolled rather than a stroke-dasharray ring, because Linear's mark is a
/// filled pie and a dashed stroke reads as a dotted outline at 14px.
function wedgePath(fraction: number): string {
  if (fraction <= 0) return "";
  if (fraction >= 1) return "M 3.5,3.5 m -3.5,0 a 3.5,3.5 0 1,0 7,0 a 3.5,3.5 0 1,0 -7,0";

  const angle = fraction * 2 * Math.PI;
  const x = 3.5 * Math.sin(angle);
  const y = -3.5 * Math.cos(angle);
  const sweep = fraction > 0.5 ? 1 : 0;

  return `M 3.5,3.5 L 3.5,0 A 3.5,3.5 0 ${sweep},1 ${(3.5 + x).toFixed(3)},${(3.5 + y).toFixed(3)} z`;
}

export default function IssueStateIcon({
  kind,
  color,
  label,
  className,
}: {
  kind: IssueStateKind;
  /// The tracker's own colour for this exact state. Absent where the caller
  /// only knows the kind.
  color?: string | null;
  /// The state's own name — "In Review" is what the reader's workspace calls it
  /// and what they will look for, where `started` is what this app folds it
  /// into. Falls back to nothing rather than reading the kind out loud.
  label?: string;
  className?: string;
}) {
  const fill = color || KIND_COLOR[kind];
  const shared = {
    width: 14,
    height: 14,
    viewBox: "0 0 14 14",
    className: cn("size-3.5 shrink-0", className),
    role: "img" as const,
    "aria-label": label,
    "aria-hidden": label ? undefined : true,
  };

  if (kind === "completed") {
    return (
      <svg {...shared} fill={fill}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M7 0C3.13401 0 0 3.13401 0 7C0 10.866 3.13401 14 7 14C10.866 14 14 10.866 14 7C14 3.13401 10.866 0 7 0ZM11.101 5.10104C11.433 4.76909 11.433 4.23091 11.101 3.89896C10.7691 3.56701 10.2309 3.56701 9.89896 3.89896L5.5 8.29792L4.10104 6.89896C3.7691 6.56701 3.2309 6.56701 2.89896 6.89896C2.56701 7.2309 2.56701 7.7691 2.89896 8.10104L4.89896 10.101C5.2309 10.433 5.7691 10.433 6.10104 10.101L11.101 5.10104Z"
        />
      </svg>
    );
  }

  if (kind === "canceled") {
    return (
      <svg {...shared} fill={fill}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M7 14C10.866 14 14 10.866 14 7C14 3.13401 10.866 0 7 0C3.13401 0 0 3.13401 0 7C0 10.866 3.13401 14 7 14ZM5.03033 3.96967C4.73744 3.67678 4.26256 3.67678 3.96967 3.96967C3.67678 4.26256 3.67678 4.73744 3.96967 5.03033L5.93934 7L3.96967 8.96967C3.67678 9.26256 3.67678 9.73744 3.96967 10.0303C4.26256 10.3232 4.73744 10.3232 5.03033 10.0303L7 8.06066L8.96967 10.0303C9.26256 10.3232 9.73744 10.3232 10.0303 10.0303C10.3232 9.73744 10.3232 9.26256 10.0303 8.96967L8.06066 7L10.0303 5.03033C10.3232 4.73744 10.3232 4.26256 10.0303 3.96967C9.73744 3.67678 9.26256 3.67678 8.96967 3.96967L7 5.93934L5.03033 3.96967Z"
        />
      </svg>
    );
  }

  // Backlog is the one that isn't a ring at all — a dashed circle, which is
  // Linear's way of saying this is not yet on anybody's list.
  if (kind === "backlog") {
    return (
      <svg {...shared} fill={fill}>
        <path d="M13.9408 7.91426L11.9576 7.65557C11.9855 7.4419 12 7.22314 12 7C12 6.77686 11.9855 6.5581 11.9576 6.34443L13.9408 6.08573C13.9799 6.38496 14 6.69013 14 7C14 7.30987 13.9799 7.61504 13.9408 7.91426ZM13.4688 4.32049C13.2328 3.7514 12.9239 3.22019 12.5538 2.73851L10.968 3.95716C11.2328 4.30185 11.4533 4.68119 11.6214 5.08659L13.4688 4.32049ZM11.2615 1.4462L10.0428 3.03204C9.69815 2.76716 9.31881 2.54673 8.91341 2.37862L9.67951 0.531163C10.2486 0.767153 10.7798 1.07605 11.2615 1.4462ZM7.91426 0.0591659L7.65557 2.04237C7.4419 2.01449 7.22314 2 7 2C6.77686 2 6.5581 2.01449 6.34443 2.04237L6.08574 0.059166C6.38496 0.0201343 6.69013 0 7 0C7.30987 0 7.61504 0.0201343 7.91426 0.0591659ZM4.32049 0.531164L5.08659 2.37862C4.68119 2.54673 4.30185 2.76716 3.95716 3.03204L2.73851 1.4462C3.22019 1.07605 3.7514 0.767153 4.32049 0.531164ZM1.4462 2.73851L3.03204 3.95716C2.76716 4.30185 2.54673 4.68119 2.37862 5.08659L0.531164 4.32049C0.767153 3.7514 1.07605 3.22019 1.4462 2.73851ZM0.0591659 6.08574C0.0201343 6.38496 0 6.69013 0 7C0 7.30987 0.0201343 7.61504 0.059166 7.91426L2.04237 7.65557C2.01449 7.4419 2 7.22314 2 7C2 6.77686 2.01449 6.5581 2.04237 6.34443L0.0591659 6.08574ZM0.531164 9.67951L2.37862 8.91341C2.54673 9.31881 2.76716 9.69815 3.03204 10.0428L1.4462 11.2615C1.07605 10.7798 0.767153 10.2486 0.531164 9.67951ZM2.73851 12.5538L3.95716 10.968C4.30185 11.2328 4.68119 11.4533 5.08659 11.6214L4.32049 13.4688C3.7514 13.2328 3.22019 12.9239 2.73851 12.5538ZM6.08574 13.9408L6.34443 11.9576C6.5581 11.9855 6.77686 12 7 12C7.22314 12 7.4419 11.9855 7.65557 11.9576L7.91427 13.9408C7.61504 13.9799 7.30987 14 7 14C6.69013 14 6.38496 13.9799 6.08574 13.9408ZM9.67951 13.4688L8.91341 11.6214C9.31881 11.4533 9.69815 11.2328 10.0428 10.968L11.2615 12.5538C10.7798 12.9239 10.2486 13.2328 9.67951 13.4688ZM12.5538 11.2615L10.968 10.0428C11.2328 9.69815 11.4533 9.31881 11.6214 8.91341L13.4688 9.67951C13.2328 10.2486 12.924 10.7798 12.5538 11.2615Z" />
      </svg>
    );
  }

  const wedge = wedgePath(WEDGE[kind] ?? 0);

  return (
    <svg {...shared}>
      <rect x="1" y="1" width="12" height="12" rx="6" stroke={fill} strokeWidth="1.5" fill="none" />
      {wedge && <path d={wedge} fill={fill} transform="translate(3.5,3.5)" />}
    </svg>
  );
}

/// The five priority marks, always drawn — including "none".
///
/// Reserving the slot matters more than what fills it: a glyph that appears
/// only on some rows shifts every title beside it, and the eye reads the
/// resulting ragged column as disorder rather than as information. Linear draws
/// "no priority" as three flat dashes for exactly this reason, so the column is
/// the same width on every row and the *height* of the bars is the signal.
const BARS: Record<Exclude<IssuePriority, "urgent" | "none">, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const PRIORITY_LABEL: Record<IssuePriority, string> = {
  none: "No priority",
  low: "Low priority",
  medium: "Medium priority",
  high: "High priority",
  urgent: "Urgent",
};

export function IssuePriorityIcon({
  priority,
  className,
}: {
  priority: IssuePriority;
  className?: string;
}) {
  const shared = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    role: "img" as const,
    "aria-label": PRIORITY_LABEL[priority],
  };

  if (priority === "urgent") {
    return (
      // The one that is not bars at all. Urgent is a filled square with a bang
      // in it, so it reads as an alarm rather than as "one bar more than high".
      <svg {...shared} className={cn("size-4 shrink-0 text-destructive", className)} fill="currentColor">
        <path d="M3 1C1.91067 1 1 1.91067 1 3V13C1 14.0893 1.91067 15 3 15H13C14.0893 15 15 14.0893 15 13V3C15 1.91067 14.0893 1 13 1H3ZM7 4L9 4L8.75391 8.99836H7.25L7 4ZM9 11C9 11.5523 8.55228 12 8 12C7.44772 12 7 11.5523 7 11C7 10.4477 7.44772 10 8 10C8.55228 10 9 10.4477 9 11Z" />
      </svg>
    );
  }

  if (priority === "none") {
    return (
      <svg
        {...shared}
        className={cn("size-4 shrink-0 text-muted-foreground/50", className)}
        fill="currentColor"
      >
        <rect x="1.5" y="7.25" width="3" height="1.5" rx="0.5" />
        <rect x="6.5" y="7.25" width="3" height="1.5" rx="0.5" />
        <rect x="11.5" y="7.25" width="3" height="1.5" rx="0.5" />
      </svg>
    );
  }

  // Bars past the level are drawn faint rather than dropped, which is what
  // makes low and medium readable as *positions on a scale* instead of as two
  // unrelated marks.
  const lit = BARS[priority];
  const dim = (index: number) => (index <= lit ? 1 : 0.25);

  return (
    <svg
      {...shared}
      className={cn("size-4 shrink-0 text-muted-foreground", className)}
      fill="currentColor"
    >
      <rect x="1.5" y="8" width="3" height="6" rx="1" fillOpacity={dim(1)} />
      <rect x="6.5" y="5" width="3" height="9" rx="1" fillOpacity={dim(2)} />
      <rect x="11.5" y="2" width="3" height="12" rx="1" fillOpacity={dim(3)} />
    </svg>
  );
}
