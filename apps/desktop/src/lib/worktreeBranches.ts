import type { BranchList } from "@/types/events";

/// What the worktree branch picker lists, in the order it lists them.
export interface WorktreeBranchOptions {
  /// The default branch by its own name (`main`), or null where the repo has
  /// no remote default or the query rules it out.
  defaultBranch: string | null;
  local: string[];
  /// On a remote with no local copy.
  remote: string[];
}

/// The branches a new task's worktree can start on, the default branch pulled
/// out to sit first. A query keeps the names holding it, those starting with
/// it first.
export function worktreeBranchOptions(list: BranchList, query = ""): WorktreeBranchOptions {
  const fallback = list.defaultBase?.slice(list.defaultBase.indexOf("/") + 1) ?? null;
  const q = query.trim().toLowerCase();
  const keep = (b: string) => !q || b.toLowerCase().includes(q);
  const rank = (names: string[]) =>
    names
      .filter((b) => b !== fallback && keep(b))
      .sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)));
  return {
    defaultBranch: fallback && keep(fallback) ? fallback : null,
    local: rank(list.branches),
    remote: rank(list.remoteBranches),
  };
}
