import { useSyncExternalStore } from "react";

/// What the notice is about. It picks the action label and how long the card
/// stays: `completed` is news that will keep, while `asking` is an agent
/// standing still until the reader answers, so it is given twice as long to be
/// noticed.
///
/// `worktree` is the odd one and breaks two of this store's habits on purpose.
/// It is raised by the reader's own click rather than by something happening
/// off screen, and its button *destroys* rather than navigates — so it is the
/// one kind whose expiry is a real answer. Letting the bar run out means "keep
/// the worktree", which is why the card offers no way to say so: the safe
/// choice is what doing nothing already does.
///
/// `pr` is the only kind raised by something no session did. A turn ending, a
/// question asked and a tree settled are all this app's own doing; a pull
/// request turning green is CI reporting somewhere else, which is why it is the
/// one kind that fires whether or not the window has focus — the reader cannot
/// have seen it happen. See `announce` in [useSessions](./useSessions.ts) for
/// the split the other three make.
export type NoticeKind = "completed" | "asking" | "worktree" | "pr";

/// How long each kind stays on screen. Read by the card to time its own progress
/// bar, which is also what dismisses it — see [NoticeStack](../components/NoticeStack.tsx).
///
/// `worktree` takes the longer window for `asking`'s reason turned around: the
/// reader is being asked to decide something irreversible they did not go
/// looking for, and ten seconds is not long enough to read a cost and weigh it.
export const NOTICE_TTL_MS: Record<NoticeKind, number> = {
  completed: 10_000,
  asking: 15_000,
  worktree: 15_000,
  // News that will keep, like a finished turn: the pull request stays ready,
  // and the card is a shortcut to it rather than the only way to find it.
  pr: 10_000,
};

/// One in-app notice — something happened in a session the reader was not
/// looking at. A window in the background gets a desktop notification instead
/// and no notice at all, so nothing here has to survive being unseen.
export type Notice = {
  /// The session it reports on. With `kind`, its identity — a second event of
  /// the same kind replaces the first rather than stacking a duplicate row.
  ///
  /// The session *alone* used to be the key, on the grounds that a session
  /// cannot both be blocked on a question and have finished its turn. That held
  /// for three kinds and stopped holding for `pr`: CI reports on its own
  /// schedule, so a pull request can turn ready while the agent that opened it
  /// is standing still waiting for permission, and one replacing the other
  /// dropped a signal the reader had no other card for.
  sessionId: string;
  kind: NoticeKind;
  /// The whole of the card's text: "Needs permission", "Task finished". It
  /// deliberately does not name the session or the project — the reader has one
  /// window and the sidebar rail is already marking the row, so repeating the
  /// title here spends the card's width saying what the next glance says anyway.
  ///
  /// The `worktree` card states its *action* here — "Delete worktree?" — which
  /// is the same rule read the other way: it is the one thing the reader has to
  /// know, and a card whose first line was a task title would make them read to
  /// the end to find out what it wanted.
  label: string;
  /// A second line, which only the `worktree` card carries. The others are a
  /// verb the reader acts on immediately; this one is a decision, and the facts
  /// it turns on have to be on the card rather than a click away.
  detail?: string;
  /// What the notice is about, drawn muted beside the label rather than under
  /// it. Two lines of heading for a card this size read as two separate things
  /// to deal with; on one line the eye takes the action first and the subject
  /// as the qualifier it is. Only the `worktree` card has one.
  subject?: string;
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

/// A card's identity, and its React key: the session it is about and what it
/// says about it.
export function noticeKey(notice: Notice): string {
  return `${notice.sessionId}:${notice.kind}`;
}

/// The stack as it stands. What `useSyncExternalStore` reads, so the array
/// identity is the subscription's change signal and must not be rebuilt on
/// read.
export function getNotices(): Notice[] {
  return notices;
}

/// Raise a notice, replacing any this session already had of the same kind.
export function pushNotice(notice: Notice) {
  const key = noticeKey(notice);
  notices = [...notices.filter((n) => noticeKey(n) !== key), notice];
  emit();
}

/// Retire a notice — its bar ran out, the reader dismissed it or acted on it, or
/// the request it pointed at was answered.
///
/// `kind` narrows it to one card, or to a set of them. Left off, every card for
/// the session goes.
export function dismissNotice(sessionId: string, kind?: NoticeKind | NoticeKind[]) {
  const kinds = kind === undefined ? null : Array.isArray(kind) ? kind : [kind];
  const gone = (n: Notice) => n.sessionId === sessionId && (!kinds || kinds.includes(n.kind));
  if (!notices.some(gone)) return;
  notices = notices.filter((n) => !gone(n));
  emit();
}

/// What opening a session answers: the completion is read, and a pending
/// request is now on screen next to the transcript that explains it.
///
/// `pr` is deliberately absent, because nothing *answers* it. The other three
/// report something about the session itself, which opening it settles; a pull
/// request being ready is true whether or not the reader is looking at the
/// session, and stays true after they look away. That card runs its own
/// countdown out and goes. See [usePrReady](./usePrReady.ts).
///
/// Spelled out rather than written as "everything but `pr`", so a kind added
/// later has to be placed here on purpose instead of inheriting a default that
/// may not suit it.
export const ANSWERED_BY_OPENING: NoticeKind[] = ["completed", "asking", "worktree"];

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/// The live notice stack.
export function useNotices(): Notice[] {
  return useSyncExternalStore(subscribe, getNotices, getNotices);
}
