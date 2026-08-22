import { useCallback, useState } from "react";

/// Unsent composer text, keyed by the session it was typed into. `null` is the
/// new-task composer's own key, which a session UUID can never collide with.
///
/// Module-level rather than a ref, because the composer does not survive the
/// trip: `AppShell` renders the footer in a different position when it is
/// centered, so going from the empty state to a session unmounts `ChatInput`
/// and mounts a fresh one. A ref would lose the draft on exactly the switch the
/// user is most likely to make.
///
/// Deliberately not persisted. A draft is what you were in the middle of
/// saying, and an app restart is long enough that restoring it a week later
/// would read as the composer having text in it for no reason.
const drafts = new Map<string | null, string>();

/// The composer's text for one session, kept apart from every other session's.
///
/// Switching sessions must not carry a half-typed prompt across, and coming
/// back must find it where it was left. Writes go straight to the store as they
/// happen, so neither a switch nor an unmount needs to stash anything on its way
/// out — the map is already current, and the mount on the other side seeds
/// itself from it.
export function useDraft(sessionId: string | null) {
  const [message, setMessage] = useState(() => drafts.get(sessionId) ?? "");

  // Two sessions, one mounted composer: swap the text during render rather than
  // in an effect, or the outgoing session's prompt paints for a frame under the
  // incoming session's transcript.
  const [key, setKey] = useState(sessionId);
  if (key !== sessionId) {
    setKey(sessionId);
    setMessage(drafts.get(sessionId) ?? "");
  }

  const write = useCallback(
    (next: string) => {
      // An empty draft is the absence of one. Dropping the key keeps the map to
      // sessions actually holding text, so a long-lived process doesn't
      // accumulate an entry per session ever opened.
      if (next) drafts.set(sessionId, next);
      else drafts.delete(sessionId);

      setMessage(next);
    },
    [sessionId],
  );

  return [message, write] as const;
}
