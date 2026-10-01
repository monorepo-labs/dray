import { isTextField } from "@/hooks/useHotkey";
import { IS_MAC } from "@/lib/platform";

/// A way to hand focus back to the composer from outside it.
///
/// Dictation is the caller: the mic button lives in `ComposerToolbar`, which
/// reaches `ChatInput` as an opaque `ReactNode`, and the recorder itself is
/// owned by `App` — so neither can reach the text box through props. Same gap
/// `useDraft` and `useAttachments` name, and the same fix: one module-level
/// value, since there is only ever one composer on screen.
let composer: HTMLElement | null = null;

/// Called by the composer's own `ref`. `null` on unmount, which is ordinary —
/// the composer unmounts whenever the reader leaves the Chat tab.
export function registerComposer(el: HTMLElement | null) {
  composer = el;
}

/// Puts the caret back in the composer, or does nothing where there isn't one.
///
/// The caret is left where it was rather than moved to the end: a draft grows
/// at the end, so a reader who was editing mid-sentence keeps their place.
export function focusComposer() {
  composer?.focus();
}

/// The same, with the caret taken to the end of whatever is in the box.
///
/// What the Issues page's Work on it needs, and the reason it is a second
/// function: that button writes a draft into a composer nobody has touched, so
/// there is no place to keep — and `RichInput` only honours the caret it is
/// handed while the box has focus, which left the tag drawn with the caret at
/// index 0 in front of it.
///
/// **A frame late, deliberately.** The caller has just written the draft, so
/// the text is not in the DOM until React has committed — and a range put at
/// the end of an empty box is a range at 0. The selection is set rather than
/// reported: `RichInput` has no prop for this, and its own `selectionchange`
/// listener reads the answer back out for the pickers, which is why the focus
/// has to land *before* the range or that listener drops it.
export function focusComposerEnd() {
  const el = composer;
  if (!el) return;

  requestAnimationFrame(() => focusAtEnd(el));
}

function focusAtEnd(el: HTMLElement) {
  el.focus();

  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/// Where a printable key belongs to whatever has focus rather than to the
/// composer: an open menu or dialog, where Radix typeahead reads letters.
const OWNS_KEYS = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox]";

/// Sends a printable key, or a paste, pressed elsewhere in the app to the
/// composer.
///
/// Installed on `document` by `ChatInput`, so it exists only while the Chat
/// view has a composer. It moves focus and nothing else: WebKit re-reads the
/// focused node between `keydown` and inserting the text, and runs ⌘V's Paste
/// against the new focus too, so both land in the box itself and go through
/// `RichInput`'s own handlers. Space is left alone, being what activates the
/// focused row or button.
export function typeIntoComposer(e: KeyboardEvent) {
  const el = composer;
  if (!el || e.defaultPrevented || e.isComposing) return;
  const paste =
    (IS_MAC ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "v";
  const typed = !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && e.key !== " ";
  if (!paste && !typed) return;

  const target = e.target instanceof HTMLElement ? e.target : null;
  if (isTextField(target) || target?.closest(OWNS_KEYS)) return;
  // The question card is a `<form>` whose choices answer to keys of their own.
  // The composer is one too, and its own buttons should still hand over.
  const form = target?.closest("form");
  if (form && !form.contains(el)) return;
  // Mounted but not drawn — Settings hides the shell rather than unmounting it.
  if (el.getClientRects().length === 0) return;

  focusAtEnd(el);
}
