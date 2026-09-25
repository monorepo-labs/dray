import { useRef } from "react";

import { useTheme } from "@/hooks/useTheme";
import { resolvedModeFor, THEMES } from "@/lib/theme";
import { cn } from "@/lib/utils";

/// Every palette as a named square, picked by looking at it. Settings' Theme row
/// and the demo pages' theme bar draw the same one.
///
/// Each swatch carries `data-theme` and `data-mode` itself, so the palette blocks in
/// App.css match it exactly as they match `<html>` and it paints that theme's own
/// backdrop — gradient and all. A swatch therefore cannot drift from the theme it
/// stands for, which a table of colours in this file could and eventually would.
///
/// Names are drawn, not hovered for. A colour says what a theme *looks* like and the
/// name says which one it is, and both are wanted at once. It also puts the name
/// inside the button, so the accessible name is the visible one. `compact` drops
/// them for a small square, where the name moves to `aria-label`.
export default function ThemeSwatches({
  labelledBy,
  label,
  compact,
}: {
  labelledBy?: string;
  label?: string;
  compact?: boolean;
}) {
  const { theme, mode, setTheme } = useTheme();
  const index = THEMES.findIndex((t) => t.id === theme);
  const { refs: swatches, onKeyDown } = useRovingGroup(THEMES.length, index, (next) =>
    setTheme(THEMES[next].id),
  );

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("flex items-start", compact ? "gap-2" : "gap-3")}
    >
      {THEMES.map(({ id: name, label }, i) => (
        <button
          key={name}
          ref={(el) => {
            swatches.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={theme === name}
          tabIndex={theme === name ? 0 : -1}
          aria-label={compact ? label : undefined}
          onClick={() => setTheme(name)}
          className="group flex cursor-pointer flex-col items-center gap-1.5 outline-none"
        >
          <span
            data-theme={name}
            // What clicking it gives: the reader's chosen mode as this
            // theme renders it, not the document's. On a dark-only theme the
            // document is dark while a light reader stays light, and every
            // other swatch has to say so.
            data-mode={resolvedModeFor(name, mode)}
            className={cn(
              "theme-swatch rounded-md border transition-colors",
              compact ? "size-8" : "size-12",
              // An outline, not a ring: a ring's offset is painted in a
              // colour, and the page under it is glass with no fill to match.
              theme === name
                ? "border-transparent outline-2 outline-offset-2 outline-ring"
                : "border-border group-hover:border-muted-foreground/60 group-focus-visible:border-ring",
            )}
          />
          {!compact && (
            <span
              className={cn("text-ui", theme === name ? "text-foreground" : "text-muted-foreground")}
            >
              {label}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/// Arrow keys, Home and End for a group of buttons where one is picked, the way a
/// `radiogroup` or a `tablist` promises a screen reader it behaves.
///
/// Shared by every picker of that shape rather than written per picker. `role`
/// is a promise to a screen reader that the keyboard behaves this way, and two
/// copies of it is two chances for one to quietly stop keeping it. Roving
/// `tabIndex` is the other half and lives at the call site: without it every
/// option is its own Tab stop.
///
/// Selection follows focus because every group here is cheap to try — trying one
/// *is* seeing it, which is the case the pattern exists for.
export function useRovingGroup(count: number, index: number, onPick: (next: number) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (next: number) => {
    onPick(next);
    refs.current[next]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Home and End are part of the same promise the arrows are: a screen reader
    // told this is a radio group or a tab list expects all four.
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      move(e.key === "Home" ? 0 : count - 1);
      return;
    }

    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    move((index + step + count) % count);
  };

  return { refs, onKeyDown };
}
