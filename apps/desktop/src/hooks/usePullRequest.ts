import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import { isSettling } from "@/lib/pr";
import type { MergeMethod, PrUnavailable, PullRequest } from "@/types/events";

/// How often to re-ask while something is still moving. Checks report on their
/// own schedule and a CI run is the one thing here that changes under the
/// reader's eyes; a settled PR is never polled at all.
const SETTLING_POLL_MS = 15_000;

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
export function usePullRequest(cwd: string, branch: string | null, active: boolean) {
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

      try {
        const prs = await invoke<PullRequest[]>("prs_for_branch", { cwd, branch });
        // The cache is keyed, so it is written whatever the reader switched to
        // meanwhile — the answer is still true of the branch that was asked.
        cache.set(key, prs);
        fetchedAt.set(key, Date.now());
        commit(key, () => ({ prs, error: null, loading: false }));
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

  // Only while something can still change by itself — see `isSettling`. Watches
  // the whole list, not one row: a check on a PR further down the list is still
  // a check the reader is waiting on.
  const settling = state.prs.some(isSettling);
  useEffect(() => {
    if (!active || !settling) return;

    const id = setInterval(() => void load(true), SETTLING_POLL_MS);
    return () => clearInterval(id);
  }, [active, settling, load]);

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
