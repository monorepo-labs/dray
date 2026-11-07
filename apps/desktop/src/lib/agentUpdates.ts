import type { AgentUpdate, Harness, SessionIndexItem, SessionStatus } from "@/types/events";

/// Whether this agent's updater overwrites files a live child reads. The other
/// three install beside the running binary, so only these two wait on a turn
/// and hold Send.
export function overwritesInPlace(harness: Harness): boolean {
  return harness === "pi" || harness === "fx";
}

/// Whether a turn may be running on this agent.
///
/// Walks the statuses, not `rows`: the archived view swaps the running sessions
/// out of the sidebar's list. A running session with no row could be on any
/// agent, so it counts, which delays an update and never breaks a turn.
export function turnRunningOn(
  harness: Harness,
  statuses: Record<string, SessionStatus>,
  rows: Pick<SessionIndexItem, "sessionId" | "harness">[],
): boolean {
  const harnessOf = new Map(rows.map((row) => [row.sessionId, row.harness]));
  return Object.entries(statuses).some(
    ([sessionId, status]) =>
      status === "in_progress" && (harnessOf.get(sessionId) ?? harness) === harness,
  );
}

/// The update to run on its own now, or `null`.
///
/// `tried` is each agent's last attempted version: a failure stays on the update
/// list, and every update ends in a fresh check, so without it a failing updater
/// would run again the moment it finished. A newer release is a new attempt.
export function nextAutoUpdate(
  updates: AgentUpdate[],
  enabled: Harness[],
  turnRunning: (harness: Harness) => boolean,
  tried: ReadonlyMap<Harness, string>,
): AgentUpdate | null {
  return (
    updates.find(
      (u) =>
        enabled.includes(u.harness) &&
        tried.get(u.harness) !== u.latest &&
        !(overwritesInPlace(u.harness) && turnRunning(u.harness)),
    ) ?? null
  );
}
