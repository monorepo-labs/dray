import { Check, Mic, X } from "lucide-react";

import { cx } from "./Window";

/// Bars drawn. Odd, so there is a true middle for the level to peak at.
export const BARS = 9;

/// The app's ghost icon button, at the composer's `icon-sm`.
export function GhostButton({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cx("grid size-7 place-items-center rounded-full text-muted-foreground [&_svg]:size-4", className)}>
      {children}
    </span>
  );
}

/// The mic at rest.
export function MicButton({ className }: { className?: string }) {
  return (
    <GhostButton className={className}>
      <Mic strokeWidth={2} />
    </GhostButton>
  );
}

/// Tallest in the middle, the app's own taper. A flat row of equal bars
/// reads as a loading indicator.
const weight = (i: number) => 1 - (Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2)) * 0.55;

/// The row a recording draws: the level as bars, discard, then the filled
/// stop. The bars are the envelope, not a spectrum — the fixed shape spread
/// across the row. `barClass` names each bar so a scene can move it, and
/// each bar's share of the peak rides `--w` so the scene keeps one keyframe
/// list per rhythm rather than one per bar.
export function RecordingControls({
  barClass,
  className,
}: {
  barClass: (index: number) => string;
  className?: string;
}) {
  return (
    <span className={cx("flex items-center gap-1", className)}>
      <span className="flex h-4 items-center gap-[2px] px-1 text-foreground" aria-hidden>
        {Array.from({ length: BARS }, (_, i) => (
          <span
            key={i}
            className={cx("h-[18%] w-[2px] rounded-full bg-current", barClass(i))}
            style={{ "--w": weight(i) } as React.CSSProperties}
          />
        ))}
      </span>
      <GhostButton>
        <X strokeWidth={2} />
      </GhostButton>
      <span className="grid size-7 place-items-center rounded-full bg-primary text-primary-foreground [&_svg]:size-4">
        <Check strokeWidth={2.5} />
      </span>
    </span>
  );
}
