import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { compactTokens } from "@/lib/format";
import { cn } from "@/lib/utils";

/// Where the ring stops being informational and starts being a warning. A
/// context this full is minutes from compacting, and a compaction costs a turn
/// and drops detail the user may still want — so it is worth reading before it
/// happens, not after.
const TIGHT = 0.8;

/// How full the model's context is, as a ring in the composer's control row.
///
/// A ring rather than a number because the exact count is never what's wanted at
/// a glance — the question is "how much room is left", which is a proportion.
/// The count lives in the tooltip for when it is wanted.
export default function ContextMeter({ used, max }: { used: number; max: number }) {
  // A window can be exceeded on paper — the count includes the reply, which is
  // written after the prompt was admitted — and an arc past 100% wraps back to
  // looking empty.
  const fraction = max > 0 ? Math.min(used / max, 1) : 0;
  const percent = Math.round(fraction * 100);
  const tight = fraction >= TIGHT;

  // Geometry is in a 24-unit box scaled down by the SVG's own size, so the
  // stroke stays crisp at any display size and the numbers stay readable.
  const r = 9;
  const circumference = 2 * Math.PI * r;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable so the count is reachable without a pointer, but not a
            button — there is nothing to press. */}
        <span
          tabIndex={0}
          role="img"
          aria-label={`Context ${percent}% full`}
          className="flex shrink-0 items-center px-1.5 focus:outline-none"
        >
          <svg
            viewBox="0 0 24 24"
            className={cn("size-3.5", tight ? "text-destructive" : "text-muted-foreground")}
            aria-hidden
          >
            <circle
              cx="12"
              cy="12"
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              opacity="0.25"
            />
            {/* Rotated so the arc starts at twelve o'clock; SVG's own zero angle
                is three o'clock, which reads as a gauge that begins a quarter
                turn in. */}
            <circle
              cx="12"
              cy="12"
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - fraction)}
              transform="rotate(-90 12 12)"
            />
          </svg>
        </span>
      </TooltipTrigger>

      <TooltipContent>
        {compactTokens(used)} / {compactTokens(max)} · {percent}% used
      </TooltipContent>
    </Tooltip>
  );
}
