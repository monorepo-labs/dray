import type { AgentUpdate, Harness } from "@/types/events";

/// Whether this agent's updater overwrites files a live child reads. The other
/// three install beside the running binary, so only these two wait on a turn
/// and hold Send.
export function overwritesInPlace(harness: Harness): boolean {
  return harness === "pi" || harness === "fx";
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
