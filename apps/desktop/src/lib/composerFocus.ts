/// A way to hand focus back to the composer from outside it.
///
/// Dictation is the caller: the mic button lives in `ComposerToolbar`, which
/// reaches `ChatInput` as an opaque `ReactNode`, and the recorder itself is
/// owned by `App` — so neither can reach the textarea through props. Same gap
/// `useDraft` and `useAttachments` name, and the same fix: one module-level
/// value, since there is only ever one composer on screen.
let composer: HTMLTextAreaElement | null = null;

/// Called by the composer's own `ref`. `null` on unmount, which is ordinary —
/// the composer unmounts whenever the reader leaves the Chat tab.
export function registerComposer(el: HTMLTextAreaElement | null) {
  composer = el;
}

/// Puts the caret back in the composer, or does nothing where there isn't one.
///
/// The caret is left where it was rather than moved to the end: a draft grows
/// at the end, so a reader who was editing mid-sentence keeps their place.
export function focusComposer() {
  composer?.focus();
}
