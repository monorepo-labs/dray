import { useSyncExternalStore } from "react";

/// What the notice is about. It picks the action label and how long the card
/// stays: `completed` is news that will keep, while `asking` is an agent
/// standing still until the reader answers, so it is given twice as long to be
/// noticed.
export type NoticeKind = "completed" | "asking";

/// How long each kind stays on screen. Read by the card to time its own progress
/// bar, which is also what dismisses it — see [NoticeStack](../components/NoticeStack.tsx).
export const NOTICE_TTL_MS: Record<NoticeKind, number> = {
  completed: 10_000,
  asking: 15_000,
};

/// One in-app notice — something happened in a session the reader was not
/// looking at. A window in the background gets a desktop notification instead
/// and no notice at all, so nothing here has to survive being unseen.
export type Notice = {
  /// The session it reports on, which is also its identity: a session holds at
  /// most one notice, so a second event replaces the first rather than stacking
  /// a duplicate row. Nothing is lost — a session cannot both be blocked on a
  /// question and have finished its turn.
  sessionId: string;
  kind: NoticeKind;
  /// The whole of the card's text: "Needs permission", "Task finished". It
  /// deliberately does not name the session or the project — the reader has one
  /// window and the sidebar rail is already marking the row, so repeating the
  /// title here spends the card's width saying what the next glance says anyway.
  label: string;
};

/// Notices, oldest first.
///
/// Module-level for the same reason `useDraft` is: the two ends are far apart.
/// `useSessions` pushes from inside a Tauri event listener and `App` renders the
/// stack, so threading a setter between them would put toast plumbing through
/// the session hook's return.
///
/// No timers live here. Each card's countdown *is* its progress bar, and the
/// `animationend` of that bar is what calls `dismissNotice` — so pausing the
/// animation on hover pauses the dismissal too, with no second clock to keep in
/// step. It also means a card cannot expire while the window is occluded and the
/// animation is throttled, which is the behaviour we want anyway.
let notices: Notice[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/// Raise a notice, replacing any this session already had.
export function pushNotice(notice: Notice) {
  notices = [...notices.filter((n) => n.sessionId !== notice.sessionId), notice];
  emit();
}

/// Retire a notice — its bar ran out, the reader dismissed it or acted on it, or
/// the request it pointed at was answered.
export function dismissNotice(sessionId: string) {
  if (!notices.some((n) => n.sessionId === sessionId)) return;
  notices = notices.filter((n) => n.sessionId !== sessionId);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/// The live notice stack.
export function useNotices(): Notice[] {
  return useSyncExternalStore(
    subscribe,
    () => notices,
    () => notices,
  );
}
