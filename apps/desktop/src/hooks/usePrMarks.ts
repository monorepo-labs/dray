import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@/lib/transport";

import { useWindowFocused } from "@/lib/focus";
import { markDisagrees, marksGaveUp, marksRepo, marksRetryDelay, pickPrMark, sameMark } from "@/lib/pr";
import { branchChanged, inRepo, panelRead } from "@/lib/prSync";
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

/// The background poll's gap, for repos whose marks drive something off
/// screen: a bot's stalled tasks, judged every minute against a 2-minute
/// stall, and a problem its task can mend on the first read after the task
/// last moved. Slow, since every `gh` here spends the same hourly budget as the
/// agents' own.
const BACKGROUND_POLL_MS = 5 * 60_000;

/// How often repos owed a read are looked at; each waits `marksRetryDelay`.
const RETRY_TICK_MS = 15_000;

/// How long one key's read is waited on before its repo is tried through the
/// next key: a Boat's `gh` can hang, and neither it nor the socket has a
/// deadline of its own.
const ATTEMPT_MS = 20_000;

/// Last answer per repo, kept across mounts for [usePullRequest]'s reason —
/// switching projects changes the argument, and a project flipped away from and
/// back to should draw its marks immediately rather than blank and refill.
const cache = new Map<string, Map<string, PrMark>>();
/// Every mark a repo read answered, by number, unnarrowed: a merge card names
/// its own PR, which the per-branch pick may not be.
const numbered = new Map<string, Map<number, PrMark>>();
const fetchedAt = new Map<string, number>();
/// When the answer in [cache] was asked for, not when it landed: a bot's stall
/// judges whether a mark postdates the task's last move, and the gap between
/// the two is where a push hides.
const askedAt = new Map<string, number>();

/// The read currently running for a repo, so two effects landing in the same
/// frame — a turn ending in a project that is also newly visible — cost one
/// `gh`. The promise rather than a bare flag, because a *forced* read that
/// collides has to queue behind it rather than be dropped; see `load`.
///
/// It carries the time it was issued at, because "a read is running" is not
/// the same fact as "a read will answer for me". One issued before a write is
/// discarded when it lands — see `outdated` — so a later caller that stands
/// down behind it waits for an answer that never comes.
const inFlight = new Map<string, { promise: Promise<boolean>; startedAt: number }>();

/// The GitHub repo each key's marks came from — see `marksRepo`. Keys sharing
/// one are read once and all given the answer, or one repo checked out on this
/// Mac and on five Boats is six reads per poll against one hourly budget.
const repoOf = new Map<string, string>();

/// Reads that failed in a row since a key's last good one. A key in here is
/// retried with backoff until one lands, since nothing else may ever read it
/// again: the poll reads only repos holding an open PR, and a repo whose reads
/// all failed holds nothing.
const failures = new Map<string, { count: number; at: number }>();

const EMPTY: Map<string, PrMark> = new Map();

/// `path` and every key known to name the same GitHub repo.
function sharing(path: string): string[] {
  const repo = repoOf.get(path);
  if (!repo) return [path];
  return [path, ...[...repoOf].flatMap(([key, r]) => (r === repo && key !== path ? [key] : []))];
}

/// One clock for reads starting and pull requests changing, so an answer can
/// be judged against both. A read takes a tick when it starts.
///
/// A `gh` call issued *before* a merge cannot answer for that merge, and the
/// damaging half is not the stale rows: it is the freshness stamp, which would
/// tell every later reader the pre-merge answer is current and suppress the
/// read that would have corrected it.
let clock = 0;
/// When every repo last changed under a write — see `refreshAfterWrite`.
let allChangedAt = 0;
/// When one repo last changed, for an agent's report — see `refreshRepo`.
const changedAt = new Map<string, number>();
/// When the read a key's answer came from started. Keys sharing a repo are
/// read through different machines, so answers can land out of order, and an
/// older one landing last would put back a PR list from before the newer.
const answeredAt = new Map<string, number>();

/// Whether a read started at `startedAt` was issued before `key` last changed.
function outdated(key: string, startedAt: number): boolean {
  return startedAt < Math.max(allChangedAt, changedAt.get(key) ?? 0);
}

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
/// Failure is silent — no `gh`, not a GitHub repo, logged out. The mark is
/// decoration on a list that works without it, so there is nothing here to
/// report and nothing for the reader to do. It also changes nothing: a read
/// that fails leaves the entry exactly as it was, neither blanking the repo nor
/// claiming its old answer is current. See the catch in `load`.
export function usePrMarks(
  repoPaths: string[],
  /// Of `repoPaths`, the ones still read while the window is in the background,
  /// every `BACKGROUND_POLL_MS`, since what they decide is not on screen.
  backgroundPaths: readonly string[] = [],
) {
  // The effect depends on the *set*, not on the array identity a caller mints
  // fresh every render. The paths themselves are read off a ref rather than out
  // of this string, since a repo path can hold whatever separator we picked.
  const key = [...repoPaths].sort().join("\n");
  const pathsRef = useRef(repoPaths);
  pathsRef.current = repoPaths;

  const [byRepo, setByRepo] = useState<Map<string, Map<string, PrMark>>>(() => new Map(cache));

  /// `only` narrows the read to a subset of what is visible. The poll passes
  /// the repos that actually hold an open pull request: forcing every visible
  /// one meant a directory `gh` can never answer for — not a GitHub repo, or
  /// logged out for that host — got a failing spawn every 30s for as long as
  /// some *other* repo on screen had a PR open.
  /// `except` names one branch this read must not report back to the panel.
  /// Set by the read the panel itself triggered — see `panelRead` below —
  /// because the panel's answer for *that* branch is what this read is
  /// catching up to, and echoing it would have the panel re-read, disagree
  /// again wherever the two folds differ by construction, and the pair would
  /// spawn `gh` at each other forever. Only that branch: a repo-wide answer can
  /// carry news about others, and swallowing the whole response left their
  /// panel stamps fresh and wrong.
  const load = useCallback(async (force: boolean, only?: string[], except?: string) => {
    // Deferred rather than dropped, and that distinction is the whole of this
    // branch. A forced read is one the caller knows something new about — a
    // turn has just ended and may have opened a pull request — while the read
    // already running was issued before that. Skipping it on the collision
    // leaves the pre-creation answer standing until something else happens to
    // refresh, so the sidebar stays unmarked and the composer keeps offering
    // Create PR for a branch that has one.
    const deferred: string[] = [];

    const stale = (only ?? pathsRef.current).filter((path) => {
      const running = inFlight.get(path);
      if (running) {
        // Standing down is only safe where the running read can actually answer
        // for this one. If it was issued before a write it will be thrown away
        // when it lands, so a caller that skipped the path behind it leaves
        // nothing scheduled at all — and the entry it would have replaced stays
        // on screen with no stamp and no poll to correct it, since a stale
        // merged mark is exactly what holds `anyOpen` off.
        if (force || outdated(path, running.startedAt)) deferred.push(path);
        return false;
      }
      return force || Date.now() - (fetchedAt.get(path) ?? 0) >= FRESH_MS;
    });
    if (stale.length === 0 && deferred.length === 0) return;

    /// Answers whether the key is dealt with: read, or dropped for a write whose
    /// own read follows. `false` is a failure, and the caller tries a sibling.
    const read = async (path: string): Promise<boolean> => {
      // Waits for the slot rather than taking it: two reads of one repo answer
      // the same thing, and letting them overlap makes which one lands last a
      // race.
      //
      // A loop, not one await, because more than one caller can queue behind
      // the same read — a turn ending and a merge landing while one is out.
      // Each captured the *same* occupant, so on its settling they would both
      // resume and both spawn `gh`, which is the overlap this exists to stop.
      // Re-reading the slot each time makes the second wait for the first.
      let running = inFlight.get(path);
      while (running) {
        await running.promise;
        running = inFlight.get(path);
      }

      // Captured after the wait, not at `read`'s entry: this may have queued
      // behind another read, and a write landing during that wait is one this
      // attempt has not seen either. One capture serves both the guard below
      // and the slot, so what the slot advertises and what the guard enforces
      // cannot drift.
      const startedAt = ++clock;

      const attempt = (async (): Promise<boolean> => {
        let answer: Map<string, PrMark>;
        let all: PrMark[];
        const asked = Date.now();
        try {
          all = await invoke<PrMark[]>("pr_marks", { cwd: path });
          answer = marksByBranch(all);
        } catch (error) {
          if (marksGaveUp(error)) failures.delete(path);
          else failures.set(path, { count: (failures.get(path)?.count ?? 0) + 1, at: Date.now() });
          // A failed read changes nothing at all — it neither writes rows nor
          // stamps, and both halves of that are load-bearing.
          //
          // Not writing keeps the last good marks on screen, the rule
          // [usePullRequest] holds its own list by. Blanking them was a bug: a
          // transient `gh` hiccup emptied a repo the reader could see.
          //
          // Not stamping is what this used to get wrong in the other direction.
          // Reusing the cached answer and stamping it fresh looked harmless and
          // was not, because `refreshAfterWrite` clears the stamps and marks the
          // change *before* its forced read: that read starts after it, so a
          // failure sails past the guard below and re-certifies
          // the pre-merge answer the write had just invalidated. The sidebar
          // then holds the old glyph for the full window — and a stale merged
          // mark keeps `anyOpen` false, so the poll that would fix it never
          // starts.
          //
          // Leaving it unstamped is not a cost worth buying back. Stamps only
          // gate `load(false)`, which runs when the visible repo set changes —
          // a project switch, not a render — and the poll reads only the repos
          // holding an open PR, which a repo `gh` cannot answer for never is.
          // What does re-read it is the retry, off `failures`.
          return false;
        }

        // Dropped whole if a write landed while this was out. The `gh` call was
        // issued before the merge, so it cannot describe it — and writing it
        // would not just paint one stale row, it would re-stamp the entry as
        // fresh and suppress the read that corrects it. Leaving the entry
        // unstamped is what makes the next visit refetch.
        if (outdated(path, startedAt)) return true;

        const repo = marksRepo(all);
        if (repo) repoOf.set(path, repo);
        for (const key of sharing(path)) {
          failures.delete(key);
          if (outdated(key, startedAt) || startedAt < (answeredAt.get(key) ?? 0)) continue;
          answeredAt.set(key, startedAt);
          const before = cache.get(key);
          cache.set(key, answer);
          numbered.set(key, new Map(all.map((pr) => [pr.number, pr])));
          fetchedAt.set(key, Date.now());
          askedAt.set(key, asked);

          // Tell the panel which branches moved, so its own cache for them is
          // stale from here and not from its next poll. Compared against the
          // previous answer rather than emitted for every branch: the poll runs
          // every 30s while anything is open, and a panel re-read on each would
          // be the second `gh` per tick this hook exists to avoid. A first read
          // has nothing to compare and says nothing — the panel reads fresh on
          // arrival anyway.
          if (before) {
            for (const branch of new Set([...before.keys(), ...answer.keys()])) {
              if (branch === except) continue;
              if (!sameMark(before.get(branch), answer.get(branch))) {
                branchChanged.emit({ repo: key, branch });
              }
            }
          }
        }
        return true;
      })();

      inFlight.set(path, { promise: attempt, startedAt });
      const done = await attempt;
      // Only if it is still ours: a later read may already have claimed the
      // slot while this one was settling.
      if (inFlight.get(path)?.promise === attempt) inFlight.delete(path);
      return done;
    };

    // One read per GitHub repo, the rest answered by it. Tried in turn rather
    // than the first alone, since the key read may sit on a stopped Boat while
    // its siblings can still answer; the one failing least goes first.
    const groups = new Map<string, string[]>();
    for (const path of new Set([...stale, ...deferred])) {
      const group = repoOf.get(path) ?? path;
      groups.set(group, [...(groups.get(group) ?? []), path]);
    }
    await Promise.all(
      [...groups.values()].map(async (paths) => {
        const tries = paths.sort((a, b) => (failures.get(a)?.count ?? 0) - (failures.get(b)?.count ?? 0));
        for (const path of tries) {
          // A late answer from a key given up on is judged by `answeredAt`.
          const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ATTEMPT_MS));
          if (await Promise.race([read(path), timeout])) return;
        }
      }),
    );

    setByRepo(new Map(cache));
  }, []);

  useEffect(() => {
    void load(false);
  }, [key, load]);

  // The panel's read is the faster one while its tab is open — 15s against
  // 30s here — so it is the first to see a check land or a merge go through.
  // Where its answer contradicts the mark, the repo is re-read now rather than
  // at the next poll, so the row cannot sit a window behind the pane beside
  // it. Only on disagreement, or every panel poll would double as a marks one.
  //
  // The repo is found by prefix: the panel hands back a session cwd, which
  // for a worktree session sits under the repo root this is keyed by. Longest
  // match, so a repo nested inside another resolves to itself.
  useEffect(
    () =>
      panelRead.subscribe(({ cwd, branch, prs }) => {
        const repo = [...cache.keys()]
          .filter((path) => inRepo(cwd, path))
          .sort((a, b) => b.length - a.length)[0];
        if (!repo || !markDisagrees(cache.get(repo)?.get(branch), prs)) return;
        fetchedAt.delete(repo);
        void load(true, [repo], branch);
      }),
    [load],
  );

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
  //
  // The repos themselves rather than a boolean, because only they are polled —
  // see `load`'s `only`. Joined into a key for the effect, which must not
  // re-run on the fresh array identity every render mints.
  const openRepos = repoPaths.filter((path) =>
    [...(byRepo.get(path) ?? EMPTY).values()].some((pr) => pr.state === "OPEN"),
  );
  const openKey = openRepos.join("\n");

  // Paused while the window is in the background, where a mark changes
  // nothing the reader can see. Coming back re-reads whatever the pause let go
  // stale, so "Ready to merge" lands on return rather than a poll later — only
  // on the return itself, since `load(false)` above already answers a change
  // of repos and a forced read beside it would queue a second `gh`.
  const focused = useWindowFocused();
  const wasFocused = useRef(focused);
  useEffect(() => {
    const returned = focused && !wasFocused.current;
    wasFocused.current = focused;
    if (!openKey || !focused) return;

    const targets = openKey.split("\n");
    const stale = targets.filter((path) => Date.now() - (fetchedAt.get(path) ?? 0) >= OPEN_POLL_MS);
    if (returned && stale.length > 0) void load(true, stale);
    const id = setInterval(() => void load(true, targets), OPEN_POLL_MS);
    return () => clearInterval(id);
  }, [openKey, focused, load]);

  // A bot's stalls are judged and announced while the window is away, so its
  // tasks' repos holding an open PR keep reading then, slowly.
  const backgroundKey = openRepos.filter((path) => backgroundPaths.includes(path)).join("\n");
  useEffect(() => {
    if (focused || !backgroundKey) return;
    const id = setInterval(() => void load(true, backgroundKey.split("\n")), BACKGROUND_POLL_MS);
    return () => clearInterval(id);
  }, [backgroundKey, focused, load]);

  // A failed read is tried again until one lands, on the same terms as the
  // polls: everything on screen while focused, a bot's repos while not. A
  // read that fails under a spent rate limit was the one that would have
  // seen a new PR, and with no open mark to poll for nothing else asked again.
  const owedKey = repoPaths
    .filter((path) => failures.has(path) && (focused || backgroundPaths.includes(path)))
    .join("\n");
  useEffect(() => {
    if (!owedKey) return;
    const owed = owedKey.split("\n");
    const id = setInterval(() => {
      const due = owed.filter((path) => {
        const failed = failures.get(path);
        return failed && Date.now() - failed.at >= marksRetryDelay(failed.count);
      });
      if (due.length > 0) void load(true, due);
    }, RETRY_TICK_MS);
    return () => clearInterval(id);
  }, [owedKey, load]);

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
    /// One pull request by number: `undefined` until the repo has been read,
    /// `null` where the read holds no such PR — closed, or merged long enough
    /// ago to fall out of the newest hundred.
    prNumbered: useCallback(
      (repoPath: string, number: number): PrMark | null | undefined => {
        void byRepo; // re-made on every read, so a caller re-renders on one
        const marks = numbered.get(repoPath);
        return marks ? (marks.get(number) ?? null) : undefined;
      },
      [byRepo],
    ),
    /// When a repo's marks were asked for, or nothing before its first read.
    readAt: useCallback(
      (repoPath: string): number | undefined => {
        void byRepo; // re-made on every read, so a caller re-renders on one
        return askedAt.get(repoPath);
      },
      [byRepo],
    ),
    /// Draws a PR merged on `merge_pr` succeeding, until the next read: waiting
    /// for that read drew the Merge button again for a beat. Only until it,
    /// since a merge queue answers success with the PR still open.
    markMerged: useCallback((repoPath: string, number: number) => {
      // A read issued before the merge would put it back open.
      allChangedAt = ++clock;
      for (const key of sharing(repoPath)) {
        const prs = numbered.get(key);
        const pr = prs?.get(number);
        if (!prs || !pr) continue;
        const all = new Map(prs).set(number, { ...pr, state: "MERGED" });
        numbered.set(key, all);
        cache.set(key, marksByBranch([...all.values()]));
        // The read that would have told the panel now finds nothing changed.
        branchChanged.emit({ repo: key, branch: pr.headRefName });
      }
      setByRepo(new Map(cache));
    }, []),
    /// Re-reads every repo currently on screen. Called when a turn ends — that
    /// is when a pull request appears.
    refresh: useCallback(() => void load(true), [load]),
    /// Re-reads one repo, for an agent saying it changed a pull request there.
    /// One repo and not every one on screen: agents push and comment all day,
    /// across every machine, and each of those re-reading the lot was most of
    /// what the marks spent. Off screen it only drops the stamp, so arriving
    /// there reads it.
    refreshRepo: useCallback(
      (repoPath: string) => {
        const keys = sharing(repoPath);
        // A read already out was asked before the change and must not stamp.
        const now = ++clock;
        for (const key of keys) {
          fetchedAt.delete(key);
          changedAt.set(key, now);
        }
        const shown = keys.filter((key) => pathsRef.current.includes(key));
        if (shown.length > 0) void load(true, shown);
      },
      [load],
    ),
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
    ///
    /// A read that fails here is retried with the rest, off `failures`: it is
    /// the read that would turn a merged mark back into an open one after a
    /// reopen, and a merged mark is not polled.
    refreshAfterWrite: useCallback(() => {
      allChangedAt = ++clock;
      fetchedAt.clear();
      void load(true);
    }, [load]),
  };
}
