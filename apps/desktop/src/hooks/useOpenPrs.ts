import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import type { OpenPr } from "@/types/events";

/// How long a repo's answer counts as fresh. Longer than the panel's own 30s,
/// because this feeds a mark rather than a view being read: the sidebar is on
/// screen the whole time, and a row's glyph appearing a minute late costs
/// nothing where a stale merge button would.
const FRESH_MS = 120_000;

/// Last answer per repo, kept across mounts for [usePullRequest]'s reason —
/// switching projects changes the argument, and a project flipped away from and
/// back to should draw its marks immediately rather than blank and refill.
const cache = new Map<string, Map<string, OpenPr>>();
const fetchedAt = new Map<string, number>();

/// Repos we are mid-flight on, so two effects landing in the same frame — a
/// turn ending in a project that is also newly visible — cost one `gh`.
const inFlight = new Set<string>();

const EMPTY: Map<string, OpenPr> = new Map();

/// Open pull requests for every repo the sidebar is showing sessions from,
/// keyed by head branch.
///
/// One query per repo rather than one per session: `gh` costs the better part
/// of a second, so a spawn per visible row would make the sidebar the most
/// expensive thing in the app. The frontend does the matching, because which
/// branch a session lands on is its own rule — `sessionBranch` rebuilds a
/// worktree session's from its worktree name — and the backend answering a map
/// would be a second copy of it.
///
/// Failure is silent and total: no `gh`, not a GitHub repo, logged out. The
/// mark is decoration on a list that works without it, so there is nothing here
/// to report and nothing for the reader to do.
export function useOpenPrs(repoPaths: string[]) {
  // The effect depends on the *set*, not on the array identity a caller mints
  // fresh every render. The paths themselves are read off a ref rather than out
  // of this string, since a repo path can hold whatever separator we picked.
  const key = [...repoPaths].sort().join("\n");
  const pathsRef = useRef(repoPaths);
  pathsRef.current = repoPaths;

  const [byRepo, setByRepo] = useState<Map<string, Map<string, OpenPr>>>(() => new Map(cache));

  const load = useCallback(async (force: boolean) => {
    const stale = pathsRef.current.filter((path) => {
      if (inFlight.has(path)) return false;
      return force || Date.now() - (fetchedAt.get(path) ?? 0) >= FRESH_MS;
    });
    if (stale.length === 0) return;

    await Promise.all(
      stale.map(async (path) => {
        inFlight.add(path);
        try {
          const prs = await invoke<OpenPr[]>("open_prs", { cwd: path });
          cache.set(path, new Map(prs.map((pr) => [pr.headRefName, pr])));
        } catch {
          // An empty map, not an absent one, and stamped like a success: a repo
          // `gh` can't answer for should stop being asked until the window
          // expires rather than on every render.
          cache.set(path, new Map());
        } finally {
          fetchedAt.set(path, Date.now());
          inFlight.delete(path);
        }
      }),
    );

    setByRepo(new Map(cache));
  }, []);

  useEffect(() => {
    void load(false);
  }, [key, load]);

  return {
    /// A session's pull request, or nothing. Takes the repo *and* the branch,
    /// since a branch name says nothing about which checkout it belongs to.
    prFor: useCallback(
      (repoPath: string, branch: string | null): OpenPr | undefined =>
        branch ? (byRepo.get(repoPath) ?? EMPTY).get(branch) : undefined,
      [byRepo],
    ),
    /// Re-reads every repo currently on screen. Called when a turn ends — that
    /// is when a pull request appears.
    refresh: useCallback(() => void load(true), [load]),
  };
}
