import { useEffect, useLayoutEffect, useRef } from "react";

import { SEGMENT_COLOR, highlightSegments } from "@/lib/highlight";
import {
  caretOf,
  diffRange,
  insertText,
  locate,
  placeCaret,
  readValue,
  renderInto,
} from "@/lib/richDom";
import { chipSignature, placeSegments, type Placed } from "@/lib/richText";
import { cn } from "@/lib/utils";

/// The fill each kind of chip takes.
///
/// **Solid in dark, tinted in light, and the split is about what the accent
/// *is* in each mode rather than a preference.** Dark draws the accents at
/// L 0.82 — brighter than the prose around them — so at 12% they are a smudge,
/// where filled they carry the page's own background as ink and read cleanly.
/// Light draws the same accents at L 0.55, darker than the prose, so a solid
/// fill there is the loudest thing in a window whose chrome is deliberately
/// quiet, while a 12% wash is exactly enough to bound the run.
///
/// Written as a `dark:` variant rather than read from `useTheme`, so the chips
/// repaint on a mode change with no state, no prop and no re-render — the class
/// is already correct for both. `.dark` is on `<html>` from the pre-paint script
/// in index.html and from `applyTheme` after it, so it is never a frame behind.
const CHIP_ACCENT: Partial<Record<Placed["segment"]["kind"], string>> = {
  mention: "bg-accent-mention/12 text-accent-mention dark:bg-accent-mention dark:text-background",
  session: "bg-accent-session/12 text-accent-session dark:bg-accent-session dark:text-background",
  issue: "bg-accent-issue/12 text-accent-issue dark:bg-accent-issue dark:text-background",
};

/// The chip's shape, which the mode does not move — only its fill does.
///
/// `align-baseline` is load-bearing: an inline-block sits on its own bottom edge
/// by default, which drops a chip a pixel below the words either side of it and
/// makes a line of prose look buckled.
///
/// **`leading-tight` is what keeps two wrapped lines apart.** An inline-block is
/// as tall as its own line-height, and inheriting the box's 1.5 made the fill
/// exactly as tall as the line it sits on — so a chip on one line and a chip on
/// the next met with no gap at all and read as one block. At 1.25 the fill is
/// shorter than its line and the prose keeps its rhythm; the text baseline does
/// not move, so nothing else shifts.
///
/// **The text is set a notch under the prose, and it is not the same size that
/// makes it look bigger.** A fill plus padding is a wider, denser mark than the
/// words either side of it, so a chip matching them exactly still reads as
/// enlarged — the size is what brings the *pill* back level with the line rather
/// than the glyphs. `em`, so it follows the reader's composer size. Weight went
/// for the same reason: the fill already separates the run, and 500 against the
/// prose's 400 was a second way to say it.
const CHIP_SHAPE =
  "inline-block cursor-default whitespace-nowrap rounded-sm px-1 align-baseline text-[0.94em] leading-tight";

/// What a run is painted.
///
/// **A URL is left plain here, where the transcript underlines it.** There it is
/// a link, and the rule says so; in the box it is a word being typed, and a rule
/// under it promises something to click that this surface does not offer. The
/// two surfaces already differ on how much of a run they draw — `splitMention`
/// is the same divergence — so this is the existing seam rather than a new one.
function classOf(placed: Placed): string {
  if (placed.label === null) {
    return placed.segment.kind === "url" ? "" : SEGMENT_COLOR[placed.segment.kind];
  }

  const accent = CHIP_ACCENT[placed.segment.kind];
  if (!accent) return SEGMENT_COLOR[placed.segment.kind];

  return cn(CHIP_SHAPE, accent);
}

type Props = {
  /// The prompt, and the only copy of it. Everything drawn below is derived.
  value: string;
  /// Where the caret is as an index into `value`. Controlled, because the
  /// pickers key off it and a pick has to be able to put it somewhere.
  caret: number;
  onChange: (value: string, caret: number) => void;
  onCaretChange: (caret: number) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  /// Rows before it stops growing and starts scrolling.
  maxRows?: number;
  /// Handed the element as well as held, so dictation can hand focus back from
  /// `App`, which has no route to it.
  innerRef?: (el: HTMLDivElement | null) => void;
};

/// The composer's text box: a `contenteditable` whose placed tags are atomic
/// chips.
///
/// **It is uncontrolled while ordinary prose is typed, and that is the whole
/// design.** React writes to this subtree only when the *chips* move — a tag
/// completed, a tag deleted into, a draft arriving from elsewhere. Every other
/// keystroke is the browser's own, which is what keeps the caret, the selection
/// and the undo stack behaving natively rather than being reimplemented here.
/// The overlay this replaces failed for exactly the opposite reason: it redrew a
/// second copy of the text on every frame and spent its whole life trying to
/// keep that copy in register.
///
/// Programmatic changes go in through `insertText` rather than by rebuilding, so
/// a pick is one undoable edit rather than a lost history.
export default function RichInput({
  value,
  caret,
  onChange,
  onCaretChange,
  onKeyDown,
  onFocus,
  onBlur,
  placeholder,
  className,
  maxRows = 10,
  innerRef,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  /// What the tree currently holds. Compared against `value` to tell the
  /// reader's own typing — already in the DOM — from a change arriving from
  /// anywhere else, which still has to be put there.
  const domValue = useRef("");
  const signature = useRef("");
  const focused = useRef(false);
  /// The caret as of the last commit, which is what tells a caret the caller
  /// *asked* for from one that simply hasn't moved since.
  const lastCaret = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const asked = caret !== lastCaret.current;
    const arrived = value !== domValue.current;
    const edit = arrived ? diffRange(domValue.current, value) : null;

    // **Text can arrive without a caret to go with it, and then the caret prop
    // is stale rather than wrong-on-purpose.** Dictation is the case: it appends
    // to the draft from `App`, which has no idea where the caret is, so honouring
    // the prop there would drag it back to wherever it sat before the reader
    // started talking. The end of what was inserted is the honest answer, and it
    // is what a pick would have asked for anyway.
    const target = asked || !edit ? caret : edit.start + edit.text.length;

    // A blurred box has no run being edited, so everything that can chip does.
    const placed = placeSegments(highlightSegments(value), focused.current ? target : null);
    const next = chipSignature(placed);

    // Put an outside change in as an edit first. Reduced to the range that
    // actually moved, a pick is the tag alone, which the browser records as one
    // undoable step — where rebuilding the tree would throw the history away.
    if (arrived && focused.current) applyEdit(el, domValue.current, value);

    // Rebuild only where the chips moved or the edit above could not land.
    // Ordinary typing reaches neither and the tree is left exactly as the
    // browser left it.
    if (next !== signature.current || readValue(el) !== value) {
      renderInto(el, placed, classOf);
      if (focused.current) placeCaret(el, target);
    } else if (arrived && focused.current && caretOf(el) !== target) {
      placeCaret(el, target);
    }

    domValue.current = value;
    signature.current = next;
    lastCaret.current = target;

    // Said back, so the pickers are reading the caret the box actually has.
    if (target !== caret) onCaretChange(target);
  }, [value, caret, onCaretChange]);

  // A contenteditable has no `onSelect`, and the caret moves for reasons no
  // element-level handler sees — arrow keys, a drag, the OS putting it back. The
  // document event is the only one that reports all of them.
  useEffect(() => {
    const onSelectionChange = () => {
      const el = ref.current;
      if (!el || !focused.current) return;

      const at = caretOf(el);
      if (at !== null) onCaretChange(at);
    };

    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [onCaretChange]);

  const read = () => {
    const el = ref.current;
    if (!el) return;

    const text = readValue(el);
    domValue.current = text;
    onChange(text, caretOf(el) ?? text.length);
  };

  return (
    <div
      ref={(el) => {
        ref.current = el;
        innerRef?.(el);
      }}
      role="textbox"
      aria-multiline
      aria-label={placeholder}
      contentEditable
      suppressContentEditableWarning
      // The browser owns the children between rebuilds, so React must never be
      // told what they are — a single reconciliation here would take the caret
      // and the undo stack with it.
      data-placeholder={placeholder}
      onInput={read}
      onFocus={() => {
        focused.current = true;
        onFocus?.();
      }}
      onBlur={() => {
        focused.current = false;
        onBlur?.();
      }}
      onKeyDown={onKeyDown}
      // Plain text only. The default would paste somebody else's markup into a
      // tree whose every element means something here, and a pasted `<span>`
      // carrying `data-tag` would be a chip addressing a session at random.
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        if (text) insertText(text);
      }}
      // Tauri intercepts a *file* drop before the webview sees it, so what
      // reaches here is text from another app — which would arrive as markup for
      // the reason above.
      onDrop={(event) => {
        event.preventDefault();
        const text = event.dataTransfer.getData("text/plain");
        if (text) insertText(text);
      }}
      className={cn(
        // `text-foreground` is not decoration: `--color-composer` exists beside
        // `--text-composer`, so a bare `text-composer` on this box resolves as a
        // *colour* and paints the prose in the card's own fill — invisible. The
        // textarea this replaces escaped it only by carrying an explicit colour
        // alongside, which is what this is.
        "relative block w-full overflow-y-auto whitespace-pre-wrap break-words text-foreground outline-none",
        // `lh` is the line box's own height, so the cap follows the composer's
        // font size wherever the reader sets it — which is the whole of what the
        // measuring effect this replaces was for. It read `scrollHeight` against
        // a cleared height on every keystroke and had to freeze the card around
        // that read to stop the transcript ratcheting; none of it survives.
        "max-h-(--composer-cap)",
        // Drawn only where there is nothing to draw over. `:empty` is no good —
        // the browser leaves a `<br>` behind after the last character is deleted,
        // so the box is empty to the reader and not to the selector.
        "before:pointer-events-none before:absolute before:text-muted-foreground before:content-[attr(data-placeholder)]",
        value !== "" && "before:content-none",
        className,
      )}
      style={{ "--composer-cap": `${maxRows}lh` } as React.CSSProperties}
    />
  );
}

/// Puts `next` in place of `prev` as one edit over the range they differ on.
///
/// `insertText` rather than a rebuild, so the browser records it on its own undo
/// stack. Returns whether it landed — it will not with the selection outside
/// this box, which is why the caller checks the tree afterwards rather than
/// trusting this.
function applyEdit(el: HTMLElement, prev: string, next: string): boolean {
  const { start, end, text } = diffRange(prev, next);
  const from = locate(el, start);
  const to = locate(el, end);

  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  return text === "" ? document.execCommand("delete") : insertText(text);
}
