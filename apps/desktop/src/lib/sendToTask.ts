import { invoke } from "@/lib/transport";
import type { SessionIndexItem } from "@/types/events";

/// Sends a session a prompt on its own settings, as `dray session send`
/// relays: a message from a button must not move the model or stance it runs on.
export async function sendToTask(task: SessionIndexItem, prompt: string): Promise<void> {
  if (task.archived) throw new Error("This task is settled. Unsettle it to send it work.");
  await invoke("send_msg", {
    sessionId: task.sessionId,
    prompt,
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
}
