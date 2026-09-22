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

  requestAnimationFrame(() => {
    el.focus();

    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}
