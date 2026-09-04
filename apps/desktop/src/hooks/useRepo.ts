import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { reconcileLog } from "@/lib/commit";
import type { Commit } from "@/types/events";

/// Same bargain [useChanges](./useChanges.ts) makes: a turn's events arrive in
/// bursts, and only *refreshes* wait them out — the first read of a directory
/// is immediate, since there is nothing on screen for waiting to protect.
const REFRESH_DEBOUNCE = 300;

/// One page of history. Deep enough that most readers never reach the end of
/// it, short enough that opening the tab costs one small read.
export const LOG_PAGE = 50;

/// Runs `read` once on activation and then on every `revision` bump behind the
/// debounce, and hands back a `refresh` that skips it.
///
/// Shared by all three reads below because they want the same rhythm and each
/// getting its own would be three places for the debounce to drift apart.
/// `active` sits in the deps for [useChanges]' reason: events that landed while
/// the view was hidden bumped `revision` with the effect off, so coming back on
/// screen has to count as a reason to re-read.
function usePolledRead(cwd: string, revision: string, active: boolean, read: () => void) {
  const started = useRef(false);

  // A new directory is a different repository, so whatever was read for the old
  // one says nothing about this one.
  const [seeded, setSeeded] = useState(cwd);
  if (seeded !== cwd) {
    setSeeded(cwd);
    started.current = false;
  }

  useEffect(() => {
    if (!cwd || !active) return;

    if (!started.current) {
      started.current = true;
      read();
      return;
    }

    const timer = setTimeout(read, REFRESH_DEBOUNCE);
    return () => clearTimeout(timer);
  }, [cwd, active, revision, read]);
}

/// The tree HEAD points at — the baseline the uncommitted list diffs against.
///
/// Its own read rather than a field on the change set, because it is what makes
/// the range: a commit moves HEAD, the id changes, and the working-tree diff
/// re-keys itself onto the new baseline without anything having to invalidate a
/// cache.
export function useHeadTree(
  cwd: string,
  revision: string,
  active: boolean,
): { tree: string | null; settled: boolean; refresh: () => void } {
  const [tree, setTree] = useState<string | null>(null);
  // Whether a read has ever come back for this directory. Without it `null`
  // says two things at once — "not a repository" and "not asked yet" — and the
  // view, which paints before the first read lands, would announce the first
  // while it means the second.
  const [settled, setSettled] = useState(false);

  const issued = useRef(0);

  const read = useCallback(() => {
    const token = ++issued.current;
    void invoke<string | null>("head_tree", { cwd })
      .then((next) => {
        if (issued.current !== token) return;
        // Identity held on an unchanged id: this feeds a cache key, and a new
        // string with the same characters would re-key it every read.
        setTree((prev) => (prev === next ? prev : next ?? null));
      })
      // A directory that isn't a repository answers `null`, so there is no
      // error here worth showing — the view draws its empty state either way.
      .catch(() => issued.current === token && setTree(null))
      .finally(() => issued.current === token && setSettled(true));
  }, [cwd]);

  const [seeded, setSeeded] = useState(cwd);
  if (seeded !== cwd) {
    setSeeded(cwd);
    setTree(null);
    setSettled(false);
  }

  usePolledRead(cwd, revision, active, read);

  return { tree, settled, refresh: read };
}

export type CommitLog = {
  commits: readonly Commit[];
  error: string | null;
  loading: boolean;
  /// Whether a read has ever come back for this directory. Carried for
  /// [useHeadTree]'s reason: until one has, an empty list says "not asked yet"
  /// rather than "no commits", and a caller that folds the two decides on an
  /// answer nobody gave it.
  settled: boolean;
  /// The last page came back full, so there is probably another behind it.
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
};

/// A commit list, a page at a time.
///
/// Which list is the caller's, because two tabs read two different ones — the
/// whole of HEAD's history, and just the commits this branch made since it
/// forked — and both want the same paging, the same race token and the same
/// `reconcileLog` behind them. Every call site names its command rather than
/// one of them inheriting a default: a default is how the second reader
/// quietly gets the first reader's list.
export function useCommitLog(
  cwd: string,
  revision: string,
  active: boolean,
  command: string,
): CommitLog {
  const [commits, setCommits] = useState<readonly Commit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [settled, setSettled] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // Read by `loadMore`, which must not close over a stale length: it is called
  // from a click, arbitrarily long after the render that defined it.
  const commitsRef = useRef<readonly Commit[]>(commits);
  commitsRef.current = commits;

  const issued = useRef(0);
  const paging = useRef(false);

  const read = useCallback(() => {
    const token = ++issued.current;
    setLoading(true);
    void invoke<Commit[]>(command, { cwd, limit: LOG_PAGE, skip: 0 })
      .then((page) => {
        if (issued.current !== token) return;
        setCommits((prev) => reconcileLog(prev, page));
        setHasMore(page.length === LOG_PAGE);
        setError(null);
      })
      .catch((e) => issued.current === token && setError(String(e)))
      .finally(() => {
        if (issued.current !== token) return;
        setLoading(false);
        setSettled(true);
      });
  }, [cwd, command]);

  const loadMore = useCallback(() => {
    if (paging.current) return;
    paging.current = true;

    const token = issued.current;
    void invoke<Commit[]>(command, {
      cwd,
      limit: LOG_PAGE,
      skip: commitsRef.current.length,
    })
      .then((page) => {
        // A refresh that landed mid-page has replaced the list this page was
        // counted against, so appending it would interleave two histories.
        if (issued.current !== token) return;
        setCommits((prev) => {
          const held = new Set(prev.map((c) => c.sha));
          // A commit landing between the two reads shifts the window, so the
          // page can repeat a row already on screen.
          return [...prev, ...page.filter((c) => !held.has(c.sha))];
        });
        setHasMore(page.length === LOG_PAGE);
      })
      .catch((e) => setError(String(e)))
      .finally(() => {
        paging.current = false;
      });
  }, [cwd, command]);

  const [seeded, setSeeded] = useState(cwd);
  if (seeded !== cwd) {
    setSeeded(cwd);
    setCommits([]);
    setError(null);
    setSettled(false);
    setHasMore(false);
  }

  usePolledRead(cwd, revision, active, read);

  return { commits, error, loading, settled, hasMore, loadMore, refresh: read };
}
