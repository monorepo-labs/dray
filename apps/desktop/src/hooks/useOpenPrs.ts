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

/// The read currently running for a repo, so two effects landing in the same
/// frame — a turn ending in a project that is also newly visible — cost one
/// `gh`. The promise rather than a bare flag, because a *forced* read that
/// collides has to queue behind it rather than be dropped; see `load`.
const inFlight = new Map<string, Promise<void>>();

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
    // Deferred rather than dropped, and that distinction is the whole of this
    // branch. A forced read is one the caller knows something new about — a
    // turn has just ended and may have opened a pull request — while the read
    // already running was issued before that. Skipping it on the collision
    // leaves the pre-creation answer standing until something else happens to
    // refresh, so the sidebar stays unmarked and the composer keeps offering
    // Create PR for a branch that has one.
    const deferred: string[] = [];

    const stale = pathsRef.current.filter((path) => {
      if (inFlight.has(path)) {
        if (force) deferred.push(path);
        return false;
      }
      return force || Date.now() - (fetchedAt.get(path) ?? 0) >= FRESH_MS;
    });
    if (stale.length === 0 && deferred.length === 0) return;

    const read = async (path: string) => {
      const running = inFlight.get(path);
      // Waits for the slot rather than taking it: two reads of one repo answer
      // the same thing, and letting them overlap makes which one lands last a
      // race.
      if (running) await running;

      const attempt = (async () => {
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
        }
      })();

      inFlight.set(path, attempt);
      await attempt;
      // Only if it is still ours: a later read may already have claimed the
      // slot while this one was settling.
      if (inFlight.get(path) === attempt) inFlight.delete(path);
    };

    await Promise.all([...stale, ...deferred].map(read));

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
