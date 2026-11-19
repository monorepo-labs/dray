import { sendToTask } from "@/lib/sendToTask";
import type { SessionIndexItem } from "@/types/events";

/// Asks a task's own agent, which holds the branch, to resolve its PR's
/// conflicts and push.
export function askToFixConflicts(task: SessionIndexItem, number: number): Promise<void> {
  return sendToTask(task, `PR #${number} has merge conflicts with its base branch. Fix them and push.`);
}
