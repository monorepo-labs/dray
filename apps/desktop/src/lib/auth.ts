import type { AgentEvent } from "@/types/events";

/// The turn that died for want of a login, if that is where the session
/// currently stands, named by its own event id.
///
/// Only the newest turn is read, and the walk stops at the first one it finds:
/// a session that has since had any turn at all is logged in, so an older
/// failure is history rather than a state to cure. That also means the answer
/// clears itself — nothing has to be told when a login succeeds, because the
/// next turn to complete says so by completing.
///
/// The id rather than a boolean, because it is also the key the notice's
/// dismissal is held under. One piece of state answers both "is there a
/// failure" and "is it the one the reader already acted on", so a second
/// failure raises the notice again without anything having to reset a flag.
export function authFailedTurn(events: AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.payload.type !== "turn_completed") continue;
    return event.payload.authFailed ? event.id : null;
  }
  return null;
}
