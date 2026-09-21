import type { AgentEvent } from "@/types/events";

/// Events that arrived for a session the app is not holding a transcript for
/// yet, kept until it is.
///
/// A spawned session's child is already streaming by the time its snapshot is
/// read, and one of the things it can stream is a permission request — the one
/// event nothing can replace, because requests are never written to the log. So
/// it does not come back in the snapshot, and dropping it left a card that was
/// never drawn over an agent waiting for its answer until the prompt timed out.
///
/// Module-level for `useDraft`'s reason: the write site is an event listener
/// registered once, and the read site is a fetch that resolves after it.
///
/// **Reading is not taking.** The hold used to be consumed at each load site —
/// a frame before that load reached React state — and an event arriving in that
/// gap was held under a session the listener still could not see, with no
/// second load coming to pick it up, since `ensureLoaded` returns early once
/// the session is loaded. The hold being the only copy, the card was simply
/// lost: the crew row went yellow over a transcript with nothing in it. So
/// `heldFor` only reads, and `dropHeld` is called on the commit that actually
/// put the session in state — the real precondition, said once.
///
/// Keyed by event id within each session, and that is not tidiness. The hold
/// happens inside a `setSessions` updater — the only place with a true reading
/// of which sessions are here — and StrictMode invokes every updater twice in
/// development, so an array would take each event twice and draw two cards with
/// one React key. A map makes the second call a no-op.
const earlyEvents = new Map<string, Map<string, AgentEvent>>();

/// A session whose snapshot never arrives keeps whatever it held, so both
/// dimensions are capped rather than trusted. Per session, well past any real
/// burst before one lands; and across sessions, because a failed send leaves an
/// entry under an id nothing will ever claim and every retry mints a fresh one.
const MAX_EARLY_EVENTS = 200;
const MAX_EARLY_SESSIONS = 32;

export const holdEarlyEvent = (event: AgentEvent) => {
  const held = earlyEvents.get(event.sessionId) ?? new Map<string, AgentEvent>();
  held.set(event.id, event);

  // Insertion-ordered, so the oldest is the first key either way.
  while (held.size > MAX_EARLY_EVENTS) {
    held.delete(held.keys().next().value!);
  }

  earlyEvents.set(event.sessionId, held);
  while (earlyEvents.size > MAX_EARLY_SESSIONS) {
    earlyEvents.delete(earlyEvents.keys().next().value!);
  }
};

/// What is held for a session, oldest first. Empty where nothing is.
export const heldFor = (sessionId: string): AgentEvent[] => [
  ...(earlyEvents.get(sessionId)?.values() ?? []),
];

/// Drops the hold. Two callers, and each knows something this file cannot: the
/// drain, which has just put these events into state, and a failed send, whose
/// session id nothing will ever claim.
export const dropHeld = (sessionId: string) => {
  earlyEvents.delete(sessionId);
};
