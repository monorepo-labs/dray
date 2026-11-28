import { useEffect, useState, useSyncExternalStore } from "react";

import { readBotRepo, readIssueRepo, setBotRepo, subscribeIssueTracker } from "@/lib/issueTracker";
import { invoke } from "@/lib/transport";
import type { IssueFilters } from "@/types/events";

/// The attached projects' GitHub repos as last read, so a second `#` opens on
/// them at once. The read is git config alone, no network.
let known: string[] | null = null;

/// The repository a bot's `#` menu reads, and the ones it can pick from.
///
/// A bot's folder holds its notes and has no remote, so the reader picks one of
/// the repos attached projects live in — the list the issues page offers — and
/// the pick is kept per bot. With none kept, the issues page's repo, else the
/// first. `repo` is `undefined` while the list is still being read and `null`
/// where no attached project is on GitHub. `undefined` as a whole outside a
/// bot's chat.
export function useBotMentionRepo(
  folder: string | null,
  active: boolean,
): { repo: string | null | undefined; repos: string[]; pick: (repo: string) => void } | undefined {
  const [repos, setRepos] = useState(known);

  useEffect(() => {
    if (!folder || !active) return;
    let live = true;
    invoke<IssueFilters>("list_issue_filters", { tracker: "github", repo: null })
      .then((filters) => {
        known = filters.teams.map((team) => team.id);
        if (live) setRepos(known);
      })
      .catch(() => live && setRepos((held) => held ?? []));
    return () => {
      live = false;
    };
  }, [folder, active]);

  const kept = useSyncExternalStore(subscribeIssueTracker, () => (folder ? readBotRepo(folder) : null));

  if (!folder) return undefined;
  const list = repos ?? [];
  const page = readIssueRepo();
  const repo =
    kept && (repos === null || list.includes(kept))
      ? kept
      : repos === null
        ? undefined
        : page && list.includes(page)
          ? page
          : (list[0] ?? null);

  return { repo, repos: list, pick: (next) => setBotRepo(folder, next) };
}
