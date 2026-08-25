import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import { pickPrMark } from "@/lib/pr";
import type { PrMark } from "@/types/events";

/// How long a repo's answer counts as fresh. Longer than the panel's own 30s,
/// because this feeds a mark rather than a view being read: the sidebar is on
/// screen the whole time, and a row's glyph appearing a minute late costs
/// nothing where a stale merge button would.
const FRESH_MS = 120_000;

/// How often to re-ask while an open pull request is on screen.
///
/// Gated on there being one, so a sidebar of merged and PR-less sessions spawns
/// nothing at all and the poll stops entirely once the last one lands. This is
/// the only reason it exists: a check starts and finishes on CI's schedule, not
/// on a turn's, and a spinning indicator that no read ever clears is worse than
/// no indicator.
///
/// Looser than the panel's 15s for [FRESH_MS]'s reason — a mark arriving half a
/// minute late costs nothing, where a merge button showing stale checks does.
const OPEN_POLL_MS = 30_000;

/// Last answer per repo, kept across mounts for [usePullRequest]'s reason —
/// switching projects changes the argument, and a project flipped away from and
/// back to should draw its marks immediately rather than blank and refill.
const cache = new Map<string, Map<string, PrMark>>();
const fetchedAt = new Map<string, number>();

/// The read currently running for a repo, so two effects landing in the same
/// frame — a turn ending in a project that is also newly visible — cost one
/// `gh`. The promise rather than a bare flag, because a *forced* read that
/// collides has to queue behind it rather than be dropped; see `load`.
const inFlight = new Map<string, Promise<void>>();

const EMPTY: Map<string, PrMark> = new Map();

/// Bumped by every write against a pull request — see `refreshAfterWrite`.
///
/// A read captures this when it starts and checks it before writing what it
/// got. A `gh` call issued *before* a merge cannot answer for that merge, and
/// the damaging half is not the stale rows: it is the freshness stamp, which
/// would tell every later reader the pre-merge answer is current and suppress
/// the read that would have corrected it.
let generation = 0;

/// One repo's answer, narrowed to the one mark each branch draws.
///
/// Grouped and then picked, rather than a last-one-wins map build: a branch can
/// carry several pull requests and the row has one glyph, so which one it is has
/// to be a rule — see `pickPrMark` — and not whichever of the two connections
/// happened to concatenate last.
function marksByBranch(prs: PrMark[]): Map<string, PrMark> {
  const byBranch = new Map<string, PrMark[]>();
  for (const pr of prs) {
    const list = byBranch.get(pr.headRefName);
    if (list) list.push(pr);
    else byBranch.set(pr.headRefName, [pr]);
  }

  return new Map(
    [...byBranch].flatMap(([branch, list]) => {
      const pick = pickPrMark(list);
      return pick ? [[branch, pick] as const] : [];
    }),
  );
}

/// The pull request each branch is marked with, per repo the sidebar is showing
/// sessions from.
///
/// Open ones and merged ones both: an open PR says the work has somewhere to
/// land, and a merged one says it landed and the session can be settled — which
/// is what the reader scans this list for at the end of a day.
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
export function usePrMarks(repoPaths: string[]) {
  // The effect depends on the *set*, not on the array identity a caller mints
  // fresh every render. The paths themselves are read off a ref rather than out
  // of this string, since a repo path can hold whatever separator we picked.
  const key = [...repoPaths].sort().join("\n");
  const pathsRef = useRef(repoPaths);
  pathsRef.current = repoPaths;

  const [byRepo, setByRepo] = useState<Map<string, Map<string, PrMark>>>(() => new Map(cache));

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
        const startedAt = generation;

        let answer: Map<string, PrMark>;
        try {
          answer = marksByBranch(await invoke<PrMark[]>("pr_marks", { cwd: path }));
        } catch {
          // An empty map, not an absent one, and stamped like a success below: a
          // repo `gh` can't answer for should stop being asked until the window
          // expires rather than on every render.
          answer = new Map();
        }

        // Dropped whole if a write landed while this was out. The `gh` call was
        // issued before the merge, so it cannot describe it — and writing it
        // would not just paint one stale row, it would re-stamp the entry as
        // fresh and suppress the read that corrects it. Leaving the entry
        // unstamped is what makes the next visit refetch.
        if (generation !== startedAt) return;

        cache.set(path, answer);
        fetchedAt.set(path, Date.now());
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

  // Whether anything on screen can still change on its own. An open pull
  // request can — its checks report, someone merges it — and nothing else here
  // can: a merged mark is final, and a repo with no PR at all grows one only
  // when a turn ends, which already refreshes.
  //
  // Deliberately not gated on `checksRunning` alone, which would be the tighter
  // read and the wrong one: checks *start* a few seconds after a turn ends, so
  // at the moment of the turn-end refresh there is nothing running to poll for
  // and the indicator would never appear at all.
  //
  // Read over `repoPaths`, **not** over the whole of `byRepo`. That map is a
  // copy of the module cache and holds every repo ever fetched, so a project
  // the reader has filtered away kept the poll running for one they can't see:
  // a `gh` every 30s against the *visible* repos, or in the archived view a
  // no-op rescheduling itself forever.
  const anyOpen = repoPaths.some((path) =>
    [...(byRepo.get(path) ?? EMPTY).values()].some((pr) => pr.state === "OPEN"),
  );

  useEffect(() => {
    if (!anyOpen) return;

    const id = setInterval(() => void load(true), OPEN_POLL_MS);
    return () => clearInterval(id);
  }, [anyOpen, load]);

  return {
    /// The pull request a session's row is marked with, or nothing. Takes the
    /// repo *and* the branch, since a branch name says nothing about which
    /// checkout it belongs to. Already narrowed to one per branch — see
    /// `pickPrMark`.
    prFor: useCallback(
      (repoPath: string, branch: string | null): PrMark | undefined =>
        branch ? (byRepo.get(repoPath) ?? EMPTY).get(branch) : undefined,
      [byRepo],
    ),
    /// Re-reads every repo currently on screen. Called when a turn ends — that
    /// is when a pull request appears.
    refresh: useCallback(() => void load(true), [load]),
    /// Same, plus every *off-screen* repo marked due for a re-read.
    ///
    /// For a write — a merge, a reopen — where [refresh] alone is not enough.
    /// It reads whatever is visible at the moment it lands, and a reader who
    /// switches project between clicking merge and the merge returning takes
    /// the mutated repo off that list: its cached mark keeps the pre-merge
    /// glyph, stamped inside the freshness window, and coming back within two
    /// minutes reuses it. A merged mark then reads as open — or worse, a
    /// reopened one reads as merged, which also holds the poll off, since that
    /// is gated on an open PR existing.
    ///
    /// Dropping the stamps rather than re-reading them costs nothing: a repo
    /// nobody is looking at spawns no `gh`, it just stops counting as fresh, so
    /// the `load(false)` that already runs on arriving at a project picks up
    /// the truth. Every repo rather than the one that changed, because the
    /// caller holds a session cwd where this is keyed by repo root — the two
    /// differ for a worktree session — and a write is rare enough that the
    /// worst case is one extra `gh` on the next project switch.
    ///
    /// The bump is what makes the clear stick. Without it a read already in
    /// flight — one issued before the merge, for a repo now off screen — lands
    /// afterwards and stamps its pre-merge answer fresh again, putting the
    /// entry back exactly where clearing it had just taken it from.
    refreshAfterWrite: useCallback(() => {
      generation += 1;
      fetchedAt.clear();
      void load(true);
    }, [load]),
  };
}
