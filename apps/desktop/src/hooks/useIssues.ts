import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
  issueGeneration,
  newIssueGeneration,
  subscribeIssueGeneration,
} from "@/lib/issue";

import type {
  Issue,
  IssueDetail,
  IssueFilters,
  IssueQuery,
  IssueRef,
  IssueUnavailable,
} from "@/types/events";

/// How many rows the page asks for. Well past a screenful, and short of a
/// workspace: the useful list is what the reader is assigned and has not
/// finished, which is rarely near this.
const PAGE_LIMIT = 100;

/// Typing in the page's search box reaches the network, so it is spaced out.
/// Longer than the composer picker's 200ms: that one filters a menu somebody is
/// mid-word in and wants to feel immediate, where this is a search box where a
/// whole phrase gets typed before the answer is wanted.
const DEBOUNCE_MS = 300;

/// How long an answer counts as fresh. Leaving the page and coming back inside
/// this window paints from the cache without a round trip, which is the trip
/// this page exists to make — pick an issue, go work, come back.
const FRESH_MS = 60_000;

/// Answers per query, kept across mounts.
///
/// Keyed by the query itself, so flipping a chip and flipping back is free and
/// nothing has to be invalidated: a different question is a different key. The
/// list is capped rather than expired, because the stamp beside it is what
/// decides staleness and this only bounds memory.
const cache = new Map<string, Issue[]>();
const fetchedAt = new Map<string, number>();

/// Small: a reader works through two or three filter combinations, not twenty.
const MAX_CACHED = 12;

const keyOf = (query: IssueQuery) =>
  JSON.stringify([
    query.text ?? "",
    query.scope,
    query.teamId ?? "",
    query.projectId ?? "",
    query.settled,
  ]);

function remember(key: string, issues: Issue[], generation: number) {
  // A read issued before the connection changed must not put its answer back
  // after `forgetIssues` took it out — and above all must not re-stamp it fresh,
  // which would tell every later reader the old key's answer is current.
  if (generation !== issueGeneration()) return;

  cache.set(key, issues);
  fetchedAt.set(key, Date.now());

  // Oldest key first — `Map` keeps insertion order, and a re-read overwrites in
  // place rather than moving, so this evicts by age of first sighting. Good
  // enough for a cap whose only job is to stop unbounded growth.
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    fetchedAt.delete(oldest);
  }
}

/// Opened issues, keyed by identifier.
///
/// Its own cache rather than a second use of the list's: the two hold different
/// shapes for the same issue — a row against a whole body — and they are read on
/// different rhythms. This one is what stops the panel re-downloading a
/// description every time a tab is switched, a session is reselected, or a row
/// is picked on the issues page and picked again.
const detailCache = new Map<string, IssueDetail>();
const detailFetchedAt = new Map<string, number>();

/// Larger than the list's cap: these are keyed one issue at a time rather than
/// one whole query at a time, so a reader working through a handful of issues
/// fills it much faster.
const MAX_DETAILS = 24;

function rememberDetail(identifier: string, detail: IssueDetail, generation: number) {
  if (generation !== issueGeneration()) return;

  detailCache.set(identifier, detail);
  detailFetchedAt.set(identifier, Date.now());

  while (detailCache.size > MAX_DETAILS) {
    const oldest = detailCache.keys().next().value;
    if (oldest === undefined) break;
    detailCache.delete(oldest);
    detailFetchedAt.delete(oldest);
  }
}

type Read = { key: string; details: Record<string, IssueDetail> };

function split(key: string): string[] {
  return key ? key.split(",") : [];
}

function cachedDetails(identifiers: string[]): Record<string, IssueDetail> {
  const found: Record<string, IssueDetail> = {};
  for (const identifier of identifiers) {
    const detail = detailCache.get(identifier);
    if (detail) found[identifier] = detail;
  }
  return found;
}

/// Drops every cached answer, lists and bodies alike.
///
/// Called when the connection changes: a key that was just connected, or
/// disconnected, makes every previous answer meaningless — including the
/// `not_connected` failure that the page's empty state was drawn from.
export function forgetIssues() {
  cache.clear();
  fetchedAt.clear();
  detailCache.clear();
  detailFetchedAt.clear();
  // Last, and it is what makes the clearing stick: a read already in flight is
  // holding the generation it started under, so from here its write is refused.
  // It also wakes every mounted hook, which would otherwise keep drawing a body
  // read with a key that has since been revoked.
  newIssueGeneration();
}

/// What `invoke` rejected with, as the backend meant it.
///
/// Tauri hands the serialized `Err` back, so this is already the right shape —
/// except when the bridge itself failed, which arrives as a string with no kind
/// of its own. Same reading [usePullRequest](./usePullRequest.ts) takes.
export function asUnavailable(e: unknown): IssueUnavailable {
  if (e && typeof e === "object" && "kind" in e) return e as IssueUnavailable;
  return { kind: "other", detail: String(e) };
}

const DEFAULT_QUERY: IssueQuery = {
  text: null,
  // The default is the useful one: what this person is meant to be working on.
  scope: "assigned",
  teamId: null,
  projectId: null,
  settled: false,
};

/// One list read, cached and debounced. The page runs two of these.
///
/// `enabled` is what makes the settled half free: a read that is never asked
/// for costs nothing, so the done and cancelled groups can be drawn collapsed
/// with no round trip behind them until somebody opens one.
function useIssueList(query: IssueQuery, enabled: boolean, generation: number) {
  const key = keyOf(query);

  const [issues, setIssues] = useState<Issue[]>(() => cache.get(key) ?? []);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState<IssueUnavailable | null>(null);
  /// Whether this list has ever answered. Distinct from `issues.length`, which
  /// cannot tell "nothing here" from "not asked yet" — and the two draw
  /// differently on a group header that has no count to show until it has.
  const [answered, setAnswered] = useState(() => cache.has(key));

  useEffect(() => {
    if (!enabled) return;

    const cached = cache.get(key);
    const fresh = Date.now() - (fetchedAt.get(key) ?? 0) < FRESH_MS;

    // Painted first whatever happens: a cached answer is what the reader was
    // looking at, and blanking it to re-fetch the same rows is the flicker this
    // cache exists to remove.
    if (cached) {
      setIssues(cached);
      setUnavailable(null);
      setAnswered(true);
    }
    if (cached && fresh) {
      // Cleared here as well as in `finally`, and this is the *only* path that
      // clears it without a request having finished. A cancelled read never
      // reaches its own `finally`, so backspacing to a query that is already
      // cached — cancelling the in-flight read for the longer one and then
      // short-circuiting — used to leave the spinner turning with nothing
      // behind it, until some later read happened to end.
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    // Captured before the request goes out, not read when it lands: that is the
    // whole of the guard.
    const reading = issueGeneration();

    const run = () => {
      invoke<Issue[]>("list_issues", { query, limit: PAGE_LIMIT })
        .then((next) => {
          if (cancelled) return;
          remember(key, next, reading);
          setIssues(next);
          setUnavailable(null);
        })
        .catch((e) => {
          if (cancelled) return;
          // The list is *not* cleared: a failed refresh should leave what the
          // reader was reading, and a failed first read has nothing to clear.
          // The banner is what says the answer is stale.
          setUnavailable(asUnavailable(e));
        })
        .finally(() => {
          if (cancelled) return;
          setLoading(false);
          setAnswered(true);
        });
    };

    // Typing is debounced; a chip or a refresh is not. A click is a single act
    // and waiting 200ms to honour one reads as lag, where every keystroke is
    // one more of a run and the reader has not finished the word yet.
    //
    // Gated on there being text at all, and deliberately *not* on there being
    // something cached to protect. That was the first version and it debounced
    // nothing that mattered: each keystroke makes a key nothing is cached
    // under, so every one of them took the un-debounced path and fired its own
    // request — which is exactly the run this exists to collapse.
    const timer = setTimeout(run, query.text ? DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, key, query, generation]);

  return { issues, loading, unavailable, loaded: answered };
}

/// The issues page's lists, its filter row's options, and the state of the read.
///
/// Filters live here rather than in the view so the read and the controls that
/// change it cannot disagree about what is on screen — the page draws what this
/// answers and owns none of it.
export function useIssues(active: boolean) {
  const [query, setQuery] = useState<IssueQuery>(DEFAULT_QUERY);
  const [filters, setFilters] = useState<IssueFilters | null>(null);
  /// Bumped to force a read the query alone would not trigger — the refresh
  /// button, and a connection that just changed under the page. It is what
  /// re-arms the effect; `forgetIssues()` beside it is what makes the read
  /// happen, since the effect's own rule is "fetch what is not fresh". The
  /// counter must not also be read as "never use the cache again" — it only
  /// ever goes up, so gating the cache on it left every later chip flip and
  /// every later visit refetching for the life of the page.
  const [generation, setGeneration] = useState(0);

  /// Whether anybody has opened a settled group yet. Sticky for the life of the
  /// page rather than per group: once the reader has asked to see finished work
  /// they are unlikely to want it taken away, and both groups come back in one
  /// read anyway.
  const [wantSettled, setWantSettled] = useState(false);

  const openQuery = useMemo(() => ({ ...query, settled: false }), [query]);
  const settledQuery = useMemo(() => ({ ...query, settled: true }), [query]);

  const open = useIssueList(openQuery, active, generation);
  const settled = useIssueList(settledQuery, active && wantSettled, generation);

  // Read once per visit rather than with every list: teams and projects change
  // on the timescale of somebody reorganising a workspace, and this is a second
  // round trip behind the rows the reader is waiting for.
  useEffect(() => {
    if (!active || filters) return;

    let live = true;
    invoke<IssueFilters>("list_issue_filters")
      .then((next) => live && setFilters(next))
      // Silent: with no filters the row simply offers less, and the list above
      // has already said whatever went wrong.
      .catch(() => {});

    return () => {
      live = false;
    };
  }, [active, filters, generation]);

  return {
    issues: open.issues,
    filters,
    query,
    setQuery,
    loading: open.loading || settled.loading,
    /// Whether the open list has ever answered. `issues.length` cannot say it:
    /// an empty workspace and a first read still in flight both read as zero
    /// rows, and the page draws them differently.
    loaded: open.loaded,
    // The open half's failure is the one worth a banner: it is the list the
    // page is *for*, and a settled group that could not be read says so by
    // staying empty under a header the reader opened.
    unavailable: open.unavailable,
    settled: {
      issues: settled.issues,
      loading: settled.loading,
      loaded: settled.loaded,
      /// Called the first time a settled group is opened. Idempotent, so a
      /// second group opening costs nothing.
      request: useCallback(() => setWantSettled(true), []),
    },
    /// Forces a read past the cache, and re-reads the filter options too — a
    /// connection that just changed has neither.
    refresh: useCallback(() => {
      forgetIssues();
      setFilters(null);
      setGeneration((n) => n + 1);
    }, []),
  };
}

/// Detail for every issue a session is tagged with, keyed by identifier.
///
/// Read from the tracker rather than drawn from the links themselves: a link
/// carries the identifier and the title, which is all a *prompt* needs, and the
/// panel wants the description, the status and the comments. The links are what
/// the tab is drawn from meanwhile, so the panel has rows before this lands and
/// keeps them if it never does.
export function useSessionIssues(issues: IssueRef[], active: boolean) {
  // Joined into a string so the effect's dependency is the *set* of
  // identifiers, not the array's identity — which is fresh on every render of
  // a session that is streaming.
  const key = issues.map((issue) => issue.identifier).join(",");

  // The tracker's own id for each link, where it has one. Rebuilt on the same
  // key rather than held in state: it is a lookup table for the read below, and
  // nothing on screen is drawn from it.
  const idFor = useMemo(() => {
    const byIdentifier = new Map<string, string>();
    for (const issue of issues) {
      // A blind link writes the identifier into both fields, and an id that is
      // not the tracker's own names nothing on its side — passing it would cost
      // a lookup that can only 404 before the fallback runs.
      if (issue.id && issue.id !== issue.identifier) byIdentifier.set(issue.identifier, issue.id);
    }
    return byIdentifier;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Subscribed rather than only read, so a connection changing under a mounted
  // panel re-runs the read below. Without it the tab kept drawing a body that
  // was fetched with a key since revoked.
  const connection = useSyncExternalStore(subscribeIssueGeneration, issueGeneration);

  // Carries the key it was built for, and anything read under another key is
  // dropped *during render* rather than in the effect. The effect runs after
  // paint, so state alone left one frame of the previous issue's description
  // under the new issue's title — most visible on the issues page, where
  // picking a row is a key change and nothing else.
  const [read, setRead] = useState<Read>(() => ({ key, details: cachedDetails(split(key)) }));
  const current = read.key === key ? read : { key, details: cachedDetails(split(key)) };

  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState<IssueUnavailable | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!active || !key) return;

    const identifiers = split(key);

    // Whatever is already in hand goes up first, before anything is asked for.
    // Without this the panel blanked and read the whole description back on
    // every tab switch, every reselect, and every second visit to a row —
    // which is what watching it say "reading the issue…" over and over was.
    const cached = cachedDetails(identifiers);
    setRead({ key, details: cached });
    if (Object.keys(cached).length > 0) setUnavailable(null);

    // Only the ones nothing fresh is held for. A session tagged with three
    // issues, two of them read a moment ago, costs one request rather than
    // three.
    const wanted = identifiers.filter(
      (identifier) => Date.now() - (detailFetchedAt.get(identifier) ?? 0) >= FRESH_MS,
    );

    if (wanted.length === 0) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const reading = issueGeneration();

    Promise.all(
      wanted.map((identifier) =>
        // The tracker's own id travels with the identifier where the link has
        // one. It is the stable half: an issue moved to another team renumbers,
        // and a lookup by the recorded spelling then answers "no such issue" for
        // work that is very much still there.
        invoke<IssueDetail>("get_issue", { identifier, id: idFor.get(identifier) ?? null })
          .then((detail) => {
            rememberDetail(identifier, detail, reading);
            return detail;
          })
          .catch((e) => {
            // One issue that cannot be read costs its own body, not the panel:
            // a session tagged with two issues, one of them since deleted,
            // still draws the other.
            if (!cancelled) setUnavailable(asUnavailable(e));
            return null;
          }),
      ),
    )
      .then((answers) => {
        if (cancelled) return;
        // Rebuilt from the cache rather than merged into what is on screen, so
        // an identifier that has left the set leaves the record with it.
        setRead({ key, details: cachedDetails(identifiers) });
        if (answers.some(Boolean)) setUnavailable(null);
      })
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [key, active, generation, connection, idFor]);

  return {
    details: current.details,
    // Left as "a read is out", not masked by what is already cached: every
    // reader of it is per-issue, and each already draws its own body when it
    // has one — so a session holding one cached issue and one still arriving
    // needs this true or the second row reads as unreadable rather than
    // pending.
    loading,
    unavailable,
    /// Forces a re-read past the cache. Forgetting first rather than passing a
    /// flag down: the effect's own rule is "fetch what is not fresh", and
    /// dropping the stamps is what makes that rule answer yes.
    refresh: useCallback(() => {
      for (const identifier of split(key)) {
        detailCache.delete(identifier);
        detailFetchedAt.delete(identifier);
      }
      // The whole generation, not just these identifiers: an upload that failed
      // to fetch is cached under its own URL in another module, and Refresh is
      // the reader asking for exactly that again. It also refuses the write of
      // any read still in flight, which would otherwise re-stamp what was just
      // dropped.
      newIssueGeneration();
      setGeneration((n) => n + 1);
    }, [key]),
  };
}
