import { prStatus } from "@/lib/pr";
import type { PrMark } from "@/types/events";

/// Whether a task's PR is ready for its merge card, by the repo's own GitHub
/// rules alone: `CLEAN` covers branch protection, required checks and required
/// reviews, and `prStatus` adds that nothing is still running.
export function readyForCard(mark: PrMark): boolean {
  return mark.state === "OPEN" && mark.mergeStateStatus === "CLEAN" && prStatus(mark).key === "ready";
}
