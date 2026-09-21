import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { SEGMENT_COLOR, highlightSegments } from "@/lib/highlight";
import {
  caretOf,
  diffRange,
  selectionRange,
  placeCaret,
  readValue,
  renderInto,
} from "@/lib/richDom";
import { chipSignature, placeSegments, pushEntry, type Entry, type Placed } from "@/lib/richText";
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
/// **`inline`, never `inline-block`, and that is about the caret.** An
/// inline-block's height joins the line box, and a chip's padding makes it
/// taller than the line it sits on — so the line grew to fit, which made the
/// caret taller than the text beside it and left lines holding a tag further
/// apart than lines without one. An inline box's padding paints without taking
/// part in that calculation, so the line stays the composer's own and the fill
/// still draws round the face. Stated as a relationship rather than in px: the
/// composer's size is the reader's (`--fs-prompt`), so every figure here would
/// be right for one setting and wrong for the rest.
/// `whitespace-nowrap` is what keeps the fill in one piece, since an inline box
/// breaking across two lines would be drawn as two.
const CHIP_SHAPE =
  "inline cursor-default whitespace-nowrap rounded-sm px-1 align-baseline text-[0.94em] leading-tight";

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
/// keystroke is the browser's own, which is what keeps the caret and the
/// selection behaving natively rather than being reimplemented here. The overlay
/// this replaces failed for exactly the opposite reason: it redrew a second copy
/// of the text on every frame and spent its whole life trying to keep that copy
/// in register.
///
/// **Nothing here asks the browser to edit for it.** A change arriving from
/// anywhere but the keyboard — a pick, dictation, a paste, ⇧⏎ — is computed as a
/// string and drawn by `renderInto`, with the caret placed at the index it
/// belongs at. `execCommand` was the other route and it is gone: it existed only
/// to keep the browser's undo history, which a chip rebuild destroys anyway
/// (undo is ours, see `history`), and what it cost was the browser deciding what
/// a programmatic edit means. Its `insertLineBreak` adds a *second* newline
/// under `pre-wrap` so the new line has something to draw, which put a character
/// in the value nobody typed and left the caret a line above the text.
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
  /// Bumped on blur, purely to re-run the effect below.
  ///
  /// A blurred box has no run being edited, so the tag the caret was sitting in
  /// has to chip — and losing focus moves nothing the effect already watches, so
  /// without this a tag typed and then clicked away from stayed plain text until
  /// the next keystroke. Focus needs no such nudge: `selectionchange` reports the
  /// caret the moment it lands, which re-runs this by itself.
  const [blurs, setBlurs] = useState(0);
  /// The undo stack, **ours and not the browser's**.
  ///
  /// A chip appearing rebuilds the subtree, and WebKit records its own history
  /// against the nodes that were there — so after one rebuild ⌘Z restores a
  /// snapshot that no longer matches and takes most of the sentence with it.
  /// Nothing can repair that stack, and the rebuild is the feature, so the
  /// native one is refused outright (`preventDefault` on every ⌘Z, whether or
  /// not there is anything to undo) and this stands in.
  ///
  /// Entries are whole values rather than edits: the text is a few hundred
  /// characters and a list of them costs nothing beside being obviously right.
  /// `run` is what makes undo land on word boundaries the way a textarea does —
  /// consecutive single characters of one kind collapse into the entry they
  /// started, and anything else opens a new one.
  const history = useRef<Entry[]>([{ text: value, caret, run: null }]);
  const at = useRef(0);
  /// Set while an undo is being applied, so the effect that records does not
  /// record the restore as a fresh edit.
  const restoring = useRef(false);

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

    // Rebuilt where the chips moved, where the value arrived from outside, or
    // where the tree has drifted from the string. Ordinary typing is none of
    // those — the browser has already put the character in — so it reaches
    // nothing here and the tree is left exactly as the browser left it.
    if (arrived || next !== signature.current || readValue(el) !== value) {
      renderInto(el, placed, classOf);
      if (focused.current) placeCaret(el, target);
    }

    domValue.current = value;
    signature.current = next;
    lastCaret.current = target;

    // A restore is already in the history — recording it would file the state
    // undone back onto the end and make the press look inert.
    if (restoring.current) restoring.current = false;
    else at.current = pushEntry(history.current, at.current, value, target);

    // Said back, so the pickers are reading the caret the box actually has.
    if (target !== caret) onCaretChange(target);
  }, [value, caret, blurs, onCaretChange]);

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
        setBlurs((n) => n + 1);
        onBlur?.();
      }}
      onKeyDown={(event) => {
        // Taken before anything else looks at it: the chord must never reach
        // the browser's own history, and `ChatInput`'s handler has no business
        // seeing a key this one answers.
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          const to = at.current + (event.shiftKey ? 1 : -1);
          const entry: Entry | undefined = history.current[to];
          if (entry) {
            at.current = to;
            restoring.current = true;
            onChange(entry.text, entry.caret);
          }
          return;
        }

        onKeyDown?.(event);
      }}
      // Plain text only. The default would paste somebody else's markup into a
      // tree whose every element means something here, and a pasted `<span>`
      // carrying `data-tag` would be a chip addressing a session at random.
      onPaste={(event) => {
        event.preventDefault();
        drop(ref.current, event.clipboardData.getData("text/plain"), onChange);
      }}
      // Tauri intercepts a *file* drop before the webview sees it, so what
      // reaches here is text from another app — which would arrive as markup for
      // the reason above.
      onDrop={(event) => {
        event.preventDefault();
        drop(ref.current, event.dataTransfer.getData("text/plain"), onChange);
      }}
      className={cn(
        // `text-foreground` is not decoration. The size class this box carries
        // used to be `text-composer`, which collided with `--color-composer` and
        // resolved as a *colour* — the card's own fill, painting the prose
        // invisible. The token is `--text-prompt` now and the collision is gone,
        // but the colour still has to be stated: a size utility sets no colour,
        // and the one inherited here is the card's text colour rather than the
        // foreground.
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

/// Puts `text` in at the caret, replacing whatever is selected.
///
/// The value is computed here and handed back rather than typed into the tree,
/// the same as every other outside change — which is why it needs both ends of
/// the selection and not just the caret.
function drop(
  el: HTMLElement | null,
  text: string,
  onChange: (value: string, caret: number) => void,
): void {
  if (!el || !text) return;

  const at = selectionRange(el);
  if (!at) return;

  const value = readValue(el);
  onChange(value.slice(0, at.start) + text + value.slice(at.end), at.start + text.length);
}
