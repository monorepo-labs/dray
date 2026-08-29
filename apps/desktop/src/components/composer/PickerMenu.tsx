import { useEffect, useRef, type ReactNode } from "react";
import { CornerDownLeft } from "lucide-react";

import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/// The list that opens over the composer while `/` or `@` is being typed.
///
/// Deliberately not a Radix menu, unlike every other picker in the toolbar:
/// those take focus when they open, and this one must not — the textarea stays
/// focused so typing keeps filtering the list. Every key it responds to is
/// handled by the composer's own `onKeyDown` and arrives here as `activeIndex`,
/// which is the same bargain the questionnaire card makes for the same reason.
///
/// `groups` arrive in render order and `activeIndex` addresses the whole list
/// flattened, so the caller's keyboard navigation and this drawing can't
/// disagree about which row is which.
///
/// Generic over its item because the two pickers differ only in what a row says.
/// Everything that was hard to get right here — the container-local scrolling,
/// the phantom-hover guard, the row metrics the visible-row count is derived
/// from — is shared rather than reimplemented per picker, which is also what
/// keeps them looking like one control rather than two similar ones.
export type PickerGroup<T> = {
  /// Set only where the grouping isn't self-evident from the contents.
  label: string | null;
  items: T[];
};

export default function PickerMenu<T>({
  groups,
  label,
  keyOf,
  renderItem,
  activeIndex,
  onPick,
  onHover,
  placement = "above",
  bare = false,
}: {
  groups: PickerGroup<T>[];
  /// Named for assistive tech, which otherwise reads an unlabelled listbox.
  label: string;
  keyOf: (item: T) => string;
  /// The row's contents only — the row itself (its height, padding, and
  /// selected fill) belongs to this component, so no picker can drift.
  renderItem: (item: T) => ReactNode;
  activeIndex: number;
  onPick: (item: T) => void;
  /// Hovering *moves* the selection rather than painting a second highlight.
  /// Two independently lit rows would leave Enter and the click landing on
  /// different items, which is the one thing this list must never do.
  onHover: (index: number) => void;
  /// Which side of the composer to open on. Above by default, where the
  /// transcript is the only thing covered; below on a new task, where the
  /// toolbar sits above the input and the empty half of the window is
  /// underneath it. The hint row swaps ends to match, so the list always stays
  /// the half nearer the input.
  placement?: "above" | "below";
  /// Follows the composer's own empty state, where the card drops its fill and
  /// border: the list drops them too and sits directly on the page. A separate
  /// prop from `placement` rather than inferred from it — the two happen to
  /// travel together today, but one is geometry and one is surface, and reading
  /// the second off the first is what makes a later third state impossible.
  bare?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  /// The last position the pointer was actually at. Compared against, not
  /// merely stored — see the guard in `handleMove`.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  // Keeps the selected row in view by scrolling *this* container and nothing
  // else. `scrollIntoView` was wrong here even with `block: "nearest"`: it
  // walks every scrollable ancestor, so arrowing through the list also nudged
  // the transcript behind it, which read as the whole view shifting.
  //
  // The container's own padding is subtracted from both edges, so a row
  // scrolled to either end stops short of the box rather than against it —
  // without that the padding only ever shows at rest, and the highlighted row
  // sat flush on the border exactly when it was the one being looked at.
  useEffect(() => {
    const list = listRef.current;
    const row = activeRef.current;
    if (!list || !row) return;

    const style = getComputedStyle(list);
    const padTop = parseFloat(style.paddingTop);
    const padBottom = parseFloat(style.paddingBottom);

    const rowBox = row.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();

    const top = listBox.top + padTop;
    const bottom = listBox.bottom - padBottom;

    if (rowBox.top < top) {
      list.scrollTop -= top - rowBox.top;
    } else if (rowBox.bottom > bottom) {
      list.scrollTop += rowBox.bottom - bottom;
    }
  }, [activeIndex]);

  /// Hover only counts when the pointer genuinely moved.
  ///
  /// Scrolling the list slides a different row under a stationary cursor, and
  /// the browser reports that as a `mousemove` at the same coordinates. Taken
  /// at face value it hijacked the selection: arrowing past the last visible
  /// row scrolled the next one into place, the phantom move selected whatever
  /// had slid under the pointer, and the highlight snapped backwards.
  const handleMove = (event: React.MouseEvent, index: number) => {
    const { clientX: x, clientY: y } = event;
    const last = pointerRef.current;
    if (last && last.x === x && last.y === y) return;

    pointerRef.current = { x, y };
    onHover(index);
  };

  if (!groups.length) return null;

  // Runs across the whole list rather than restarting per group, so it lines up
  // with the flat index the composer navigates by.
  let row = -1;
  const below = placement === "below";

  /* Outside the box: nothing about a list that never holds focus says it is
     navigable, but the hint is chrome about the list rather than part of it.
     Escape is left out — it's the one key everyone already tries.

     The fill masks the transcript scrolled behind the row — without it the text
     sat on whatever happened to be there. Body's own colour, so it reads as a
     gap in the page rather than as another surface, and the padding is the
     row's own, since the fill has to cover the text and not just sit under the
     box. Dropped with `bare` for the same reason the list drops its own. */
  const hint = (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg px-1.5 py-1 text-ui text-muted-foreground/50",
        !bare && "bg-background",
        below ? "mt-1.5" : "mb-1.5",
      )}
    >
      <KbdGroup>
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        <span className="ml-0.5">navigate</span>
      </KbdGroup>
      <KbdGroup>
        <Kbd>
          <CornerDownLeft strokeWidth={2} />
        </Kbd>
        <span className="ml-0.5">select</span>
      </KbdGroup>
    </div>
  );

  return (
    // Anchored to the card and lifted clear on whichever side it opens, so the
    // list grows into empty space rather than pushing the composer around as it
    // filters.
    //
    // `top-full`/`bottom-full` clear the card's own `py-3`, so the gap is really
    // 12px of that plus this margin. With a border to separate them that reads
    // as one box beside another; with `bare` there is no edge, so the same gap
    // reads as the list having drifted away from the input — hence the pull
    // back, sized to leave the 6px the bordered state shows.
    <div
      className={cn(
        "absolute left-0 z-50 w-full",
        below && (bare ? "top-full -mt-1.5" : "top-full mt-1.5"),
        !below && (bare ? "bottom-full -mb-1.5" : "bottom-full mb-1.5"),
      )}
    >
      {!below && hint}

      {/* The frame and the scroller are separate elements on purpose. With the
          radius on the scrolling box itself, the scrollbar is laid out in that
          box's own corner and spills past the curve — visibly clipped by it at
          the top and bottom ends. Rounding an `overflow-hidden` parent instead
          clips the scrollbar to the curve, so it stops short of the corners the
          way the rows do.

          `bg-picker`, not `bg-popover`, and it is the same fill everywhere but
          on glass. This is by some way the tallest floating surface in the app —
          fourteen rems of list over a live transcript — so the wash that reads
          as glass on a menu covers a third of the page here, and the words
          behind move under the words in it. `--veil-panel` is the heavier
          wash it takes instead; the arithmetic is beside it in App.css.

          A blur goes with it, and is not decoration: a wash is not a fill, so
          without one what shows through stays legible rather than resolving to a
          tint. Every floating frame in the app carries the pair; this one was
          the last that did not.

          `lg` here against the `xl` those frames take, and the two numbers move
          together — wash and blur are one lever with two ends. A menu is thin
          enough to need the heavier blur to hide a strip of page; this surface
          already spends the heavier wash, so only a quarter of the backdrop is
          left to hide and 24px of blur on it read as a smear of the transcript
          rather than as glass over it.

          `bare` drops the fill along with the border, the radius and the
          shadow, and they do go together: it is only ever the empty state,
          where the composer stands alone and the transcript is not rendered at
          all, so there is nothing behind the list to mask and a fill can only
          be a slab of colour laid on the page. That read as free once the page
          was opaque and the slab was its exact colour — under vibrancy the page
          is glass and no fill can match it, since painting one only stacks a
          second layer over the body's own. So the list has no surface here: the
          selected row is what marks it, and with no edge there is nothing for a
          radius to round or a shadow to lift. Rows keep their own radius either
          way — that one is the shape of the highlight, not of the box. */}
      <div
        className={cn(
          "overflow-hidden",
          bare
            ? "text-foreground"
            : "rounded-xl border border-hairline-strong bg-picker backdrop-blur-lg text-popover-foreground shadow-md",
        )}
      >
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          // One inset, not two: `p-1` rather than a taller `py`, so the gap above
          // the first row is the gap beside it. Uneven, the top read as a band
          // of empty surface above the list while the sides read as an edge.
          //
          // Seven rows either way, and that is why there are two heights: 7 ×
          // the row's own `h-8` is 14rem, and the bordered state adds the
          // 0.25rem of `p-1` at each end. Written out rather than computed, so
          // it costs nothing at render — but it does mean these numbers, `h-8`
          // and `p-1` have to move together.
          //
          // `bare` drops the inset with the box it was insetting from: with no
          // border there is nothing for the rows to be held away from, and the
          // gap only reads as the list sitting oddly short of its own edge.
          className={cn(
            "overflow-x-hidden overflow-y-auto overscroll-contain",
            bare ? "max-h-[14rem]" : "max-h-[14.5rem] p-1",
          )}
        >
          {groups.map((group, g) => (
            <div
              key={group.label ?? `group-${g}`}
              className={cn(
                g > 0 && "mt-2",
                // Only a labelled section is closed off by a rule, which today
                // means recents and nothing else. The unlabelled groups are
                // separated by their gap alone.
                g > 0 && groups[g - 1].label !== null && "border-t border-dotted border-border/40 pt-2",
              )}
            >
              {group.label && (
                <div className="px-2 pb-0.5 text-ui text-muted-foreground/50">{group.label}</div>
              )}

              {group.items.map((item) => {
                row += 1;
                const index = row;

                return (
                  <button
                    key={keyOf(item)}
                    ref={index === activeIndex ? activeRef : undefined}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    // The textarea must keep focus — losing it on mousedown would
                    // close the menu before the click ever lands.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={(e) => handleMove(e, index)}
                    onClick={() => onPick(item)}
                    // The highlight is a veil in the bare state and a fill in
                    // the framed one, for the same reason the box around it is:
                    // bare has no surface, so this lands straight on the page,
                    // and `--accent`'s flat grey is a slab there once that page
                    // is glass. `--veil-strong` composites to `--accent`'s own
                    // colour over an opaque page, so the two states match
                    // outside vibrancy. Framed keeps the fill — it sits on the
                    // popover, which is opaque by design.
                    //
                    // The token, not the 11.5% white it was written as. The two
                    // are the same value in dark, and in light a white veil on a
                    // white page is no highlight at all — the row the arrow keys
                    // were sitting on simply stopped being marked.
                    className={cn(
                      "flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-ui",
                      index === activeIndex
                        ? bare
                          ? "bg-veil-strong text-accent-foreground"
                          : "bg-accent text-accent-foreground"
                        : "text-foreground",
                    )}
                  >
                    {renderItem(item)}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {below && hint}
    </div>
  );
}
