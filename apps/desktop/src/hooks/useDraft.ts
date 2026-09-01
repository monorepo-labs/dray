import { useCallback, useSyncExternalStore } from "react";

/// Unsent composer text, keyed by the session it was typed into. `null` is the
/// new-task composer's own key, which a session UUID can never collide with.
///
/// Module-level rather than a ref, because the composer does not survive the
/// trip: `AppShell` renders the footer in a different position when it is
/// centered, so going from the empty state to a session unmounts `ChatInput`
/// and mounts a fresh one. A ref would lose the draft on exactly the switch the
/// user is most likely to make.
///
/// Module-level *also* because there are now two writers in two places, exactly
/// as in `useAttachments`: the textarea is in `ChatInput`, and the mic button
/// is in `ComposerToolbar`, which reaches `ChatInput` as an opaque `ReactNode`.
/// A transcript has to land in the draft without those two sharing props.
///
/// Deliberately not persisted. A draft is what you were in the middle of
/// saying, and an app restart is long enough that restoring it a week later
/// would read as the composer having text in it for no reason.
const drafts = new Map<string | null, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/// Sets a session's draft outright. Exported for tests and for `appendToDraft`;
/// the composer reaches it through the setter [`useDraft`] returns.
export function writeDraft(sessionId: string | null, next: string) {
  // An empty draft is the absence of one. Dropping the key keeps the map to
  // sessions actually holding text, so a long-lived process doesn't accumulate
  // an entry per session ever opened.
  if (next) drafts.set(sessionId, next);
  else drafts.delete(sessionId);

  emit();
}

/// A session's draft without subscribing to it. For tests and for callers that
/// need the current text at a moment rather than across renders.
export function readDraft(sessionId: string | null): string {
  return drafts.get(sessionId) ?? "";
}

/// Adds dictated text to the end of a session's draft.
///
/// Appends rather than replaces, and separated by a space, so speaking twice
/// builds one prompt and speaking after typing continues the sentence rather
/// than eating it. The join is skipped where the draft already ends in
/// whitespace, or a second dictation lands two spaces in.
export function appendToDraft(sessionId: string | null, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;

  const current = readDraft(sessionId);
  const join = !current || /\s$/.test(current) ? "" : " ";

  writeDraft(sessionId, current + join + trimmed);
}

/// The composer's text for one session, kept apart from every other session's.
///
/// Switching sessions must not carry a half-typed prompt across, and coming
/// back must find it where it was left. Writes go straight to the store as they
/// happen, so neither a switch nor an unmount needs to stash anything on its way
/// out — the map is already current, and the mount on the other side seeds
/// itself from it.
export function useDraft(sessionId: string | null) {
  const message = useSyncExternalStore(
    subscribe,
    // Reads the map on every render rather than holding a copy, so a write from
    // the mic button is seen by the textarea without the two being connected.
    // Safe against `useSyncExternalStore`'s reference check because the value is
    // a string: equal strings compare equal.
    () => readDraft(sessionId),
  );

  const setMessage = useCallback((next: string) => writeDraft(sessionId, next), [sessionId]);

  return [message, setMessage] as const;
}
