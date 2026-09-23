import type { LucideIcon } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/// Both options drawn side by side as glyphs, with the active one filled — the
/// diff pane's split/unified pick and a doc's read/edit mode.
///
/// A single glyph that swapped on click was tried first and read as a picture
/// of the current state rather than as a control — nothing about it said it
/// could be pressed. Two segments make the choice visible before it is made.
/// A fill rather than [Segmented]'s sliding thumb, at this size.
export default function IconToggle<T extends string>({
  value,
  options,
  onChange,
  tooltips = false,
}: {
  value: T;
  options: { value: T; label: string; Icon: LucideIcon }[];
  onChange: (next: T) => void;
  /// Names each glyph on hover. Off where the pair says what each does by
  /// contrast; `aria-label` carries the word either way.
  tooltips?: boolean;
}) {
  return (
    // `--surface-well`, the track token, rather than a muted fill: the well is
    // a black scrim in both modes, so on a light page it cuts *into* the row
    // instead of sitting a shade off it — which is what lets the thumb read as
    // raised rather than as the one segment that happens to be greyer.
    <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-surface-well p-0.5">
      {options.map(({ value: option, label, Icon }) => {
        const button = (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-label={label}
            aria-pressed={value === option}
            className={cn(
              "rounded-[min(var(--radius-md),6px)] p-1 transition-colors",
              // The thumb has to come up past the surface the row is drawn at,
              // out of the well the track cuts — so it takes `--surface-thumb`
              // and the button shadow, the pair the composer's own segmented
              // control uses. An accent fill is a veil, and a veil over a scrim
              // is a few percent of light that reads as nothing.
              value === option
                ? "bg-surface-thumb text-foreground shadow-(--shadow-button)"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" strokeWidth={1.5} />
          </button>
        );
        return tooltips ? (
          <Tooltip key={option}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="left">{label}</TooltipContent>
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}
