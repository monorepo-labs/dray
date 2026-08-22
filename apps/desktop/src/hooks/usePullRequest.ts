import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
export function usePullRequest(cwd: string, branch: string | null, active: boolean) {
  const key = branch ? keyOf(cwd, branch) : null;

  const [state, setState] = useState<State>(() => ({
    prs: key ? (cache.get(key) ?? []) : [],
    error: null,
    loading: false,
  }));
  const [acting, setActing] = useState(false);

  /// Which PR the panel is showing, by number rather than by index — a refetch
  /// can reorder the list (merging one drops it below the open ones) and an
  /// index would quietly select a different PR underneath the reader.
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);

  // Read inside async work that outlives the render it started in, so a fetch
  // landing after a session switch can tell it is answering the wrong branch.
  const keyRef = useRef(key);
  keyRef.current = key;

  const load = useCallback(
    async (force: boolean) => {
      if (!branch || !key) return;

      const fresh = Date.now() - (fetchedAt.get(key) ?? 0) < FRESH_MS;
      if (!force && fresh && cache.has(key)) {
        setState({ prs: cache.get(key) ?? [], error: null, loading: false });
        return;
      }

      setState((prev) => ({ ...prev, loading: true }));

      try {
        const prs = await invoke<PullRequest[]>("prs_for_branch", { cwd, branch });
        cache.set(key, prs);
        fetchedAt.set(key, Date.now());
        if (keyRef.current === key) setState({ prs, error: null, loading: false });
      } catch (e) {
        // The previous answer stays up: a failed refresh is a refresh that
        // failed, not the PR going away.
        if (keyRef.current === key) {
          setState((prev) => ({ ...prev, error: asUnavailable(e), loading: false }));
        }
      }
    },
    [cwd, branch, key],
  );

  // Adopt whatever the cache already holds on the way in, so a switch back
  // paints before the fetch it also kicks off lands. The selection is dropped
  // with it — it belongs to the branch being left, not to the one arriving.
  useEffect(() => {
    setState({ prs: key ? (cache.get(key) ?? []) : [], error: null, loading: false });
    setSelectedNumber(null);
  }, [key]);

  useEffect(() => {
    void load(false);
  }, [load]);

  // A refetch when the tab is opened, in case the window sat idle past the
  // freshness cutoff while another tab was showing.
  useEffect(() => {
    if (active) void load(false);
  }, [active, load]);

  // Defaults to the first, which the backend has already sorted to be the open
  // one. Falls back the same way if the selected PR disappears from the list.
  const pr = useMemo(
    () => state.prs.find((p) => p.number === selectedNumber) ?? state.prs[0] ?? null,
    [state.prs, selectedNumber],
  );

  // Only while something can still change by itself — see `isSettling`. Watches
  // the whole list, not the shown one: a check on the PR behind the selector is
  // still a check the reader is waiting on.
  const settling = state.prs.some(isSettling);
  useEffect(() => {
    if (!active || !settling) return;

    const id = setInterval(() => void load(true), SETTLING_POLL_MS);
    return () => clearInterval(id);
  }, [active, settling, load]);

  /// Runs a write against the shown PR and refetches. The refetch is not
  /// deferred optimism — a merge closes the PR and moves it down the list, so
  /// the panel reads the new state back rather than guessing at it.
  const act = useCallback(
    async (action: PrAction) => {
      if (!pr || acting) return;

      setActing(true);
      try {
        if (action.kind === "merge") {
          await invoke("merge_pr", { cwd, number: pr.number, method: action.method });
        } else {
          const command = action.kind === "reopen" ? "reopen_pr" : "mark_pr_ready";
          await invoke(command, { cwd, number: pr.number });
        }
        setState((prev) => ({ ...prev, error: null }));
      } catch (e) {
        setState((prev) => ({ ...prev, error: asUnavailable(e) }));
      } finally {
        setActing(false);
        await load(true);
      }
    },
    [cwd, pr, acting, load],
  );

  return {
    ...state,
    pr,
    select: setSelectedNumber,
    acting,
    refresh: useCallback(() => void load(true), [load]),
    act,
  };
}
