import { readComposerPrefs } from "@/hooks/useComposerPrefs";
import { issueTag } from "@/lib/issue";
import { rememberedModel, usableEffort, usableModel } from "@/lib/model";
import { stanceFor } from "@/lib/permission";
import type { PrPicks } from "@/lib/prInbox";
import { invoke, LOCAL, serverOfPath, type ServerId } from "@/lib/transport";
import type { IssueRef, Model, Project, SessionIndexItem } from "@/types/events";

/// What a task from the issues page runs on: a new task's picks.
export type IssuePicks = PrPicks & { useWorktree: boolean };

/// The picks a new task last started on, as the New Task composer remembers
/// them, never the selected session's.
export function lastTaskPicks(): IssuePicks {
  const stored = readComposerPrefs();
  const model = rememberedModel(stored.modelByHarness, stored.harness);
  return {
    harness: stored.harness,
    model,
    effort: stored.effortByModel[model] ?? null,
    permissionMode: stanceFor(stored.harness, stored.permissionMode),
    fast: stored.fast,
    useWorktree: stored.useWorktree,
  };
}

/// `picks` mended against the models `server` runs, as the pickers mend a
/// stale pick: a remembered model the agent dropped would start nothing.
export async function usablePicks(server: ServerId, picks: IssuePicks): Promise<IssuePicks> {
  const models = await invoke<Model[]>("list_models", { harness: picks.harness }, server).catch(() => [] as Model[]);
  const runs = models.find((m) => m.id === usableModel(models, picks.model, picks.harness));
  if (!runs) return picks;
  return { ...picks, model: runs.id, effort: usableEffort(runs, picks.effort, "high") };
}

/// A GitHub issue's repository as `owner/repo`, off its `owner/repo#12`
/// identifier. A Linear issue names none.
export function issueRepo(issue: Pick<IssueRef, "tracker" | "identifier">): string | null {
  if (issue.tracker !== "github") return null;
  const at = issue.identifier.lastIndexOf("#");
  return at > 0 ? issue.identifier.slice(0, at) : null;
}

/// The attached checkout a task for `issue` runs in: the one whose git remote
/// is the issue's repository. This Mac's leads where several machines hold one,
/// then the project last picked. None for a Linear issue, or a repo not here.
export function projectForIssue(
  projects: readonly Project[],
  issue: Pick<IssueRef, "tracker" | "identifier">,
): Project | undefined {
  const repo = issueRepo(issue);
  if (!repo) return undefined;
  // `Project.remote` is git.rs's `repo_key`: host and path, lowercased.
  const key = `github.com/${repo}`.toLowerCase();
  const rank = (p: Project) => (serverOfPath(p.path) === LOCAL ? 0 : 1);
  return projects
    .filter((p) => p.remote === key)
    .sort((a, b) => rank(a) - rank(b) || b.lastSelected.localeCompare(a.lastSelected))[0];
}

/// The prompt a task for `issue` starts from: its tag, which chips in the
/// transcript, the link, the body as the tracker holds it, and the reader's
/// note last.
export function issuePrompt(
  issue: Pick<IssueRef, "identifier" | "title" | "url">,
  body: string | null,
  note = "",
): string {
  const head = [issueTag(issue.identifier, issue.title), issue.url].filter(Boolean).join("\n");
  return [head, body?.trim(), note.trim()].filter(Boolean).join("\n\n");
}

/// Tasks linked to `issue`, newest first.
export function tasksForIssue(items: readonly SessionIndexItem[], issue: Pick<IssueRef, "identifier">) {
  return items
    .filter((i) => i.issues.some((r) => r.identifier === issue.identifier))
    .sort((a, b) => b.created.localeCompare(a.created));
}
