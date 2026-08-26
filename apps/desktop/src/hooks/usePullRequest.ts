import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import { isSettling } from "@/lib/pr";
import { branchChanged, panelRead } from "@/lib/prSync";
import type { MergeMethod, PrUnavailable, PullRequest } from "@/types/events";

/// How often to re-ask while something is still moving. Checks report on their
/// own schedule and a CI run is the one thing here that changes under the
/// reader's eyes; a settled PR is never polled at all.
const SETTLING_POLL_MS = 15_000;

/// How often to re-ask about an open pull request with nothing visibly moving.
///
/// A check that has not *registered* yet is indistinguishable from no CI at
/// all: the rollup is empty either way, so `isSettling` reads false and the
/// faster poll above never starts. That is the common case for a PR the app
/// just opened — GitHub takes a few seconds to a minute to attach the first
/// run — and it left the panel showing "no checks" until the reader hit refresh
/// by hand.
///
/// So an open PR is polled whatever its rollup says, just more slowly, and the
/// first check to appear promotes it to the settling rate. Same reasoning
/// [usePrMarks](./usePrMarks.ts) gates its own poll on "any open PR" rather than
/// on "any check running": the tighter read has nothing to watch during exactly
/// the window that needs watching.
///
/// Still gated on `active`, so this only runs while the PR tab is the one being
/// looked at. A settled PR costs one `gh` a minute for as long as it is on
/// screen, which is the price of not making the reader ask twice.
const OPEN_POLL_MS = 60_000;

/// How long a fetched answer counts as fresh. Switching tabs or sessions and
/// coming back inside this window paints from the cache without a round trip —
/// `gh` costs the better part of a second, which reads as the panel reloading
/// every time it is looked at.
const FRESH_MS = 30_000;

/// Last answer per branch, kept across mounts. The panel unmounts nothing, but
/// switching sessions changes its props, and a session flipped away from and
/// back to should show what it showed before rather than start over.
const cache = new Map<string, PullRequest[]>();
const fetchedAt = new Map<string, number>();

const keyOf = (cwd: string, branch: string) => `${cwd} ${branch}`;

// The sidebar's read saw this branch change. Every cwd's stamp for it goes,
// not just the selected one: the marks are keyed by repo root and the panel by
// cwd, which differ for a worktree session, and a stale stamp anywhere is a
// stale panel the next time that session is opened. The rows stay — a
// dropped stamp means "re-read on next look", never "blank".
branchChanged.subscribe((branch) => {
  for (const key of fetchedAt.keys()) {
    if (key.endsWith(` ${branch}`)) fetchedAt.delete(key);
  }
});

const isOpen = (pr: PullRequest) => pr.state === "OPEN";

/// What `invoke` rejected with, as the backend meant it.
///
/// Tauri hands the serialized `Err` back, so this is already the right shape —
/// except when the bridge itself failed, which arrives as a string and has no
/// kind of its own.
function asUnavailable(e: unknown): PrUnavailable {
  if (e && typeof e === "object" && "kind" in e) return e as PrUnavailable;
  return { kind: "other", detail: String(e) };
}

/// Whether the tab should exist at all for this session.
///
/// Hidden for the two states where a PR tab is a promise the app can't keep: no
/// `gh` on the machine, and a directory that is not a GitHub repo. Both are
/// properties of the setup rather than of the work, so a tab that only ever
/// says "you can't use this" is chrome on every session forever.
///
/// A logged-out `gh` keeps the tab: whoever installed it works with GitHub, and
/// the fix is one command that the panel can name.
export function prTabVisible(prs: PullRequest[], error: PrUnavailable | null): boolean {
  if (error) return error.kind !== "no_cli" && error.kind !== "no_remote";
  return prs.length > 0;
}

export type PrAction =
  | { kind: "merge"; method: MergeMethod }
  | { kind: "reopen" }
  | { kind: "ready" };

type State = {
  /// Every PR opened from this branch, open ones first. Usually one, sometimes
  /// none, and occasionally several — the same work opened against two bases,
  /// or a stack where each PR's base is the branch below it.
  prs: PullRequest[];
  /// Why we couldn't ask — not installed, not logged in, not a repo. Never
  /// thrown: this pane is a side view, and a missing `gh` is not a broken app.
  /// Distinct from an empty `prs`, which means we asked and there is none.
  error: PrUnavailable | null;
  loading: boolean;
};

/// A session's pull requests, and the things that can be done to the selected
/// one.
///
/// Called by `App` rather than by the panel, because the tab row needs the
/// answer before the tab is opened: a session with an open PR puts that tab
/// first, and a panel that only fetched once its own tab was showing could
/// never order the row it sits under.
///
/// So the first read is *not* gated on `active` — only the poll is, which is
/// the half [useChanges](./useChanges.ts) was really guarding. One read per
/// session selection, deduped by the freshness window below.
///
/// Nothing here holds a "current" PR. Something did, and it was the bug: see
/// `act`.
export function usePullRequest(
  cwd: string,
  branch: string | null,
  active: boolean,
  /// Called the moment a branch that had no open pull request turns out to have
  /// one. Fired from inside `load` rather than derived by the caller from
  /// `prs`, because only the fetch knows what the *previous* answer was — and
  /// the previous answer is the whole guard. A first read has none, so opening
  /// the app onto a session that already has a PR is not an appearance and
  /// raises nothing.
  onOpened?: () => void,
  /// Called after a write here succeeds. A merge, a reopen or a ready-for-review
  /// changes what every *other* view of this branch should say, and the sidebar
  /// mark is the one that would otherwise sit wrong the longest — it reads from
  /// its own per-repo cache with a two-minute window. This hook refetches its
  /// own list either way; the callback is for the readers it doesn't own.
  onChanged?: () => void,
) {
  const key = branch ? keyOf(cwd, branch) : null;

  const [state, setState] = useState<State>(() => ({
    prs: key ? (cache.get(key) ?? []) : [],
    error: null,
    loading: false,
  }));
  const [acting, setActing] = useState(false);

  // Read inside async work that outlives the render it started in, so a write
  // landing after a session switch can tell it is answering the wrong branch.
  const keyRef = useRef(key);
  keyRef.current = key;

  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;

  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  /// Every write to `state` goes through this.
  ///
  /// An action or a read started in one session can land after the reader has
  /// switched to another: the hook instance is `App`'s and survives the switch,
  /// so a stale `setState` writes one branch's answer into another's. Guarding
  /// only the *completions* was not enough — the visible cost was `loading`
  /// stuck true forever, because a stale refresh set it on the way in and its
  /// guarded completion then dropped the write that would have cleared it.
  const commit = useCallback((k: string | null, update: (prev: State) => State) => {
    if (keyRef.current === k) setState(update);
  }, []);

  const load = useCallback(
    async (force: boolean) => {
      if (!branch || !key) return;

      const fresh = Date.now() - (fetchedAt.get(key) ?? 0) < FRESH_MS;
      if (!force && fresh && cache.has(key)) {
        commit(key, () => ({ prs: cache.get(key) ?? [], error: null, loading: false }));
        return;
      }

      commit(key, (prev) => ({ ...prev, loading: true }));

      // Read before the write below, since that is what makes this an
      // appearance rather than a first sighting.
      const before = cache.get(key);

      try {
        const prs = await invoke<PullRequest[]>("prs_for_branch", { cwd, branch });
        // The cache is keyed, so it is written whatever the reader switched to
        // meanwhile — the answer is still true of the branch that was asked.
        cache.set(key, prs);
        fetchedAt.set(key, Date.now());
        commit(key, () => ({ prs, error: null, loading: false }));
        // Whatever the reader switched to: the answer is about this branch,
        // and the mark it is checked against is too.
        panelRead.emit({ cwd, branch, prs });

        // Guarded on the key for the same reason every other write here is: a
        // read that lands after a session switch must not pull the panel open
        // onto a branch the reader has left.
        if (keyRef.current === key && before && !before.some(isOpen) && prs.some(isOpen)) {
          onOpenedRef.current?.();
        }
      } catch (e) {
        // The previous answer stays up: a failed refresh is a refresh that
        // failed, not the PR going away.
        commit(key, (prev) => ({ ...prev, error: asUnavailable(e), loading: false }));
      }
    },
    [cwd, branch, key, commit],
  );

  // Adopt whatever the cache already holds on the way in, so a switch back
  // paints before the fetch it also kicks off lands. `acting` resets with it:
  // a write still in flight belongs to the branch being left, and leaving the
  // flag set would disable the arriving session's buttons.
  useEffect(() => {
    setState({ prs: key ? (cache.get(key) ?? []) : [], error: null, loading: false });
    setActing(false);
  }, [key]);

  useEffect(() => {
    void load(false);
  }, [load]);

  // A refetch when the tab is opened, in case the window sat idle past the
  // freshness cutoff while another tab was showing.
  useEffect(() => {
    if (active) void load(false);
  }, [active, load]);

  // The sidebar's read saw this branch's pull request change — the same
  // reading that raises "Ready to merge". Re-read at once, tab or no tab: this
  // is the read the card lands on, and it is one `gh` per real change rather
  // than per poll. Other branches only lose their stamp, above.
  useEffect(() => {
    if (!branch) return;
    return branchChanged.subscribe((changed) => {
      if (changed === branch) void load(true);
    });
  }, [branch, load]);

  // Two rates, and which one applies is the whole of this. An open PR is always
  // worth re-asking about — a check can still arrive, someone can still comment
  // — and `isSettling` only says whether something is *visibly* in flight, so it
  // picks the speed rather than gating the poll. Gating on it left a fresh PR
  // whose checks had not registered yet polling zero times.
  //
  // Both watch the whole list, not one row: a check on a PR further down it is
  // still a check the reader is waiting on.
  const settling = state.prs.some(isSettling);
  const anyOpen = state.prs.some(isOpen);
  useEffect(() => {
    if (!active || !anyOpen) return;

    const id = setInterval(() => void load(true), settling ? SETTLING_POLL_MS : OPEN_POLL_MS);
    return () => clearInterval(id);
  }, [active, anyOpen, settling, load]);

  /// Runs a write against `number` and refetches.
  ///
  /// The PR is an argument, not something this hook remembers. It *was*
  /// remembered, for a selector the panel stopped drawing when the list
  /// replaced it — after which nothing ever set the selection, so every row's
  /// button acted on whichever PR sorted first. A merge is the one action here
  /// that cannot be taken back, so its target has to come from the row that was
  /// clicked and from nowhere else.
  ///
  /// The refetch is not deferred optimism: a merge closes the PR and moves it
  /// down the list, so the panel reads the new state back rather than guessing.
  const act = useCallback(
    async (number: number, action: PrAction) => {
      if (acting) return;
      const k = key;

      setActing(true);
      try {
        if (action.kind === "merge") {
          await invoke("merge_pr", { cwd, number, method: action.method });
        } else {
          const command = action.kind === "reopen" ? "reopen_pr" : "mark_pr_ready";
          await invoke(command, { cwd, number });
        }
        commit(k, (prev) => ({ ...prev, error: null }));
        // Not key-guarded, and that is the difference from every other write
        // here: this one refreshes a *repo-wide* read that is true of the
        // branch whether or not the reader is still looking at it.
        onChangedRef.current?.();
      } catch (e) {
        commit(k, (prev) => ({ ...prev, error: asUnavailable(e) }));
      } finally {
        // Both guarded together: the arriving session owns `acting` now, and
        // refreshing a branch the reader has left would overwrite its rows.
        if (keyRef.current === k) {
          setActing(false);
          await load(true);
        }
      }
    },
    [cwd, key, acting, load, commit],
  );

  return {
    ...state,
    acting,
    refresh: useCallback(() => void load(true), [load]),
    act,
  };
}
