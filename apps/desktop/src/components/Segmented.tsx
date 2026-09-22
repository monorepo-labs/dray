import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/// A two-way pick drawn as a track with a thumb that slides between its halves.
///
/// The app's own segmented control, the shape [DiffPane]'s style toggle and the
/// composer's use: `--surface-well` cuts a scrim into the row in both modes, so
/// the thumb reads as *raised out of it* rather than as the one segment that
/// happens to be greyer. Round rather than `rounded-md`, since both callers
/// stand in rows of pills.
///
/// **The thumb is one element that slides**, where `DiffPane`'s is a fill on
/// whichever segment is pressed. A fill can only cut and appear, which at this
/// size is the two labels blinking; a thumb that travels is what says the pair
/// is one control with a position rather than two lamps. It has to be *one*
/// node to do that, so it sits under the buttons rather than inside either.
///
/// **Exactly two options, deliberately.** Both callers are two-valued, and it
/// is two that makes the geometry a constant — half the track, one width of
/// travel — where an `n` would put a computed width and a computed transform on
/// every render for a case nothing here has.
///
/// **A two-column grid, and `inline-` so it is only as wide as it needs to be.**
/// Both halves have to be equal for the thumb's one width of travel to land,
/// and `grid-cols-2` is what says that in one word — a flex row of `flex-1`
/// segments splits whatever width it is *given*, which in the `#` menu's header
/// was the whole menu, and shrink-wrapping that row would have divided the sum
/// of two unequal labels in half and squeezed the longer one. The columns are
/// `minmax(auto, 1fr)`, so the widest label sets both.
///
/// [DiffPane]: ./changes/DiffPane.tsx
export default function Segmented<T extends string>({
  value,
  options,
  onPick,
  label,
  className,
}: {
  value: T;
  options: readonly [Option<T>, Option<T>];
  onPick: (value: T) => void;
  /// Names the group for a screen reader. The segments are often glyphs, so
  /// there is nothing on screen that does it.
  label: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative inline-grid shrink-0 grid-cols-2 rounded-full bg-surface-well p-0.5",
        className,
      )}
      role="group"
      aria-label={label}
    >
      {/* No gap between the segments, which is what lets this be exact: each is
          half of what the padding leaves, so travelling its own width lands the
          thumb on the other one. A gap would put a third number in that sum for
          nothing anybody can see behind an opaque thumb. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full",
          "bg-surface-thumb shadow-(--shadow-button)",
          "transition-transform duration-200 ease-out motion-reduce:transition-none",
          value === options[1].value && "translate-x-full",
        )}
      />

      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          aria-label={option.label}
          // The composer keeps focus in its editor while the `#` menu is open,
          // so a press that moved focus would close the picker before the click
          // landed. Harmless on a page, where nothing is listening for a blur —
          // one rule beats two behaviours.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(option.value)}
          className={cn(
            // `relative` alone lifts it over the thumb — no `z-10`, since the
            // thumb is an earlier sibling and both are positioned.
            "relative flex items-center justify-center whitespace-nowrap rounded-full",
            "px-2 py-1 text-ui transition-colors",
            value === option.value
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.content ?? option.label}
        </button>
      ))}
    </div>
  );
}

type Option<T extends string> = {
  value: T;
  /// What a screen reader hears, and what is drawn where `content` is absent.
  label: string;
  /// A glyph, where the label would be the widest thing in a row of them.
  content?: ReactNode;
};
