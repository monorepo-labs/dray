import { recordFixAsk } from "@/hooks/useFixAsks";
import { invoke } from "@/lib/transport";
import type { SessionIndexItem } from "@/types/events";

/// Asks a task's own agent, which holds the branch, to resolve its PR's
/// conflicts and push. Sent on the task's own settings, as `dray session send`
/// relays: a message must not move the model or stance it runs on.
export async function askToFixConflicts(task: SessionIndexItem, number: number): Promise<void> {
  if (task.archived) throw new Error("This task is settled. Unsettle it to send it work.");
  await invoke("send_msg", {
    sessionId: task.sessionId,
    prompt: `PR #${number} has merge conflicts with its base branch. Fix them and push.`,
    attachmentPaths: [],
    harness: task.harness,
    model: task.model,
    effort: task.effort,
    permissionMode: task.permissionMode,
    fast: task.fast,
    cwd: task.cwd,
    branch: null,
    useWorktree: false,
    worktreeName: null,
    baseRef: null,
    isNewSession: false,
  });
  recordFixAsk(task.sessionId, number, "conflict");
}
