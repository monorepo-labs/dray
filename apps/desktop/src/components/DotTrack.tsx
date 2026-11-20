import { cn } from "@/lib/utils";

// Dot geometry, in px, kept here because the track's offset is computed from it
// rather than measured: `size-1` plus `gap-1`.
const DOT = 4;
const DOT_GAP = 4;
const DOT_PITCH = DOT + DOT_GAP;
// Five slots. Odd, so there is a real middle for the active dot to sit in.
const DOT_TRACK_W = DOT_PITCH * 5 - DOT_GAP;

/// A switcher's map: one dot per entry, **the active one always in the
/// middle**, so the row slides under a fixed centre rather than a marker
/// travelling along a fixed row. That is what keeps the indicator readable once
/// there are more entries than dots that fit.
///
/// The track holds its width whatever the count, and the row always slides.
/// Hugging the dots to centre the *group* while they fit was tried and is why
/// this comment exists: with the group centred there is nothing left to move,
/// so a switch became a colour change and the whole control stopped feeling
/// like anything. The sliding row **is** the smoothness.
///
/// Shared by the sidebar's space and project switchers and a bot pane's view
/// switcher, since a reader meeting the same shape twice should not have to
/// learn it twice.
export default function DotTrack({
  count,
  activeIndex,
  className,
}: {
  count: number;
  activeIndex: number;
  className?: string;
}) {
  // Reserved height, so revealing the track never shifts what is under it. One
  // entry is the whole story already — a lone dot would offer a step that
  // can't go anywhere.
  return (
    <div className="h-1.5">
      {count > 1 && (
        <div
          className={cn("flex h-full items-center overflow-hidden", className)}
          style={{
            width: DOT_TRACK_W,
            // Faded at both ends, so a dot leaving the track reads as sliding
            // out rather than as being cut off.
            maskImage:
              "linear-gradient(to right, transparent, black 30%, black 70%, transparent)",
          }}
        >
          <div
            className="flex items-center transition-transform duration-200 ease-out"
            style={{
              gap: DOT_GAP,
              // Puts the active dot's centre on the track's centre.
              transform: `translateX(${DOT_TRACK_W / 2 - DOT / 2 - activeIndex * DOT_PITCH}px)`,
            }}
          >
            {Array.from({ length: count }, (_, i) => (
              <span
                key={i}
                className={cn(
                  "size-1 shrink-0 rounded-full transition-colors",
                  i === activeIndex ? "bg-foreground/80" : "bg-muted-foreground/30",
                )}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
