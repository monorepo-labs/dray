import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { pushNotice } from "@/hooks/useNotices";
import {
  isSettled,
  issueGeneration,
  newIssueGeneration,
  subscribeIssueGeneration,
  trackerOf,
} from "@/lib/issue";
import { readIssueRepo, setIssueRepo } from "@/lib/issueTracker";

import type {
  Issue,
  IssueDetail,
  IssueFilters,
  IssuePriority,
  IssueQuery,
  IssueRef,
  IssueState,
  IssueTracker,
  IssueUnavailable,
} from "@/types/events";

/// How many rows a list read asks for. Well past a screenful, and short of a
/// workspace: the useful list is what the reader is assigned and has not
/// finished, which is rarely near this.
///
/// Exported because the composer's `#` picker reads with it too. The cache below
/// is keyed on the *query* and not on the depth it was read to, so a picker
/// asking for fewer rows would write a truncated answer under the key the page
/// then paints from.
export const ISSUE_LIST_LIMIT = 100;

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

/// An object rather than a tuple, because the key is read back apart from being
/// compared: `settledOfKey` below needs one field out of it, and a positional
/// shape would hand it a different field the day this gains one.
const keyOf = (query: IssueQuery) =>
  JSON.stringify({
    // First, and it is load-bearing: two trackers answer the same
    // scope-and-settled question with entirely different issues, so without it
    // flipping the chip paints Linear's list under GitHub's chip.
    tracker: query.tracker,
    text: query.text ?? "",
    scope: query.scope,
    teamId: query.teamId ?? "",
    projectId: query.projectId ?? "",
    label: query.label ?? "",
    settled: query.settled,
  });

/// Which half of the workspace a cached list asked for, read back out of its own
/// key. By name, so adding a field to `keyOf` cannot silently change what this
/// answers.
const settledOfKey = (key: string) => Boolean((JSON.parse(key) as IssueQuery).settled);

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

/// This cache's answer for `query`, and whether it is still fresh.
///
/// Exported for the composer's `#` picker, which asks the question the issues
/// page opens with (`assigned`, unsettled) and so is usually reading an entry
/// the page already filled. Both halves, since the picker uses them for
/// different things: a stale answer is still worth *painting* while a read runs,
/// where a fresh one is worth not making the read at all.
export function cachedIssues(query: IssueQuery): { issues: Issue[]; fresh: boolean } | undefined {
  const key = keyOf(query);
  const issues = cache.get(key);
  if (!issues) return undefined;

  return { issues, fresh: Date.now() - (fetchedAt.get(key) ?? 0) < FRESH_MS };
}

/// Files a list read under `query`, so the picker's reads warm the page and the
/// page's warm the picker.
export function rememberIssues(query: IssueQuery, issues: Issue[], generation: number) {
  remember(keyOf(query), issues, generation);
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

/// What a menu picked. The **whole** state, not its id, and that is what makes
/// the optimistic paint below possible: the menu already held the name, the kind
/// and the colour the row has to draw, so nothing has to be read back to show
/// the change.
export type IssuePatch = { state?: IssueState; priority?: IssuePriority };

/// Puts back what the caches held before an optimistic patch, and leaves what it
/// restored **stale**.
///
/// Stale rather than re-stamped, because a failed command does not prove the
/// write failed: `update_issue` mutates and then re-reads, so a mutation that
/// landed under a read that did not comes back as an error. Restoring the old
/// value keeps an unconfirmed status off the screen; clearing the stamp is what
/// then sends one read to find out which of the two actually happened.
type Rollback = () => void;

/// Writes in flight per issue, chained so one lands before the next is sent.
///
/// **Keyed by the tracker's stable id, never the identifier.** One issue can be
/// two spellings at once — a session linked to `DRA-53` reading a body that now
/// calls itself `ENG-12` — and two surfaces writing under two aliases would take
/// two independent places in the queue and race each other again.
const queues = new Map<string, Promise<unknown>>();

/// How many writes are outstanding per issue, so a completion can tell whether
/// another is coming behind it and leave the settling to that one.
const outstanding = new Map<string, number>();

/// Whether this completion is the last one for its issue, and so the one that
/// reconciles. Read *before* [`released`] takes this write off the count.
function settles(id: string): boolean {
  return (outstanding.get(id) ?? 1) === 1;
}

function released(id: string) {
  const left = (outstanding.get(id) ?? 1) - 1;
  if (left > 0) {
    outstanding.set(id, left);
    return;
  }
  // Nothing else is waiting, so no later write is chained off this queue entry
  // and dropping it cannot orphan one.
  outstanding.delete(id);
  queues.delete(id);
}

/// One issue with the patch applied. Serves `Issue` and `IssueDetail` alike,
/// since both carry exactly these two fields.
function patched<T extends { state: IssueState; priority: IssuePriority }>(
  issue: T,
  patch: IssuePatch,
): T {
  return {
    ...issue,
    state: patch.state ?? issue.state,
    priority: patch.priority ?? issue.priority,
  };
}

/// Writes the patch into every cached answer holding this issue, and **stamps
/// each one fresh**.
///
/// The stamp is the load-bearing half, and getting it wrong is visible. Every
/// mounted reader re-reads its own cache on a generation bump and then asks the
/// network for whatever is stale — so an entry left with its old stamp fires a
/// read *immediately*, that read leaves before the mutation lands, and Linear
/// answers with the status the reader has just moved away from. It then writes
/// that answer back over the patch. On screen: the new status, then the old one,
/// then the new one again once the reconcile lands.
///
/// It was tempting to read the stamp as "when the tracker last told us", which
/// this is not — but `FRESH_MS` is a minute, so on any list older than that the
/// race is not a race at all, it happens every time. Stamped, nothing goes out
/// until the write says so.
///
/// **Everything is matched on the stable id, bodies included** — the identifier
/// is a cache *slot*, never an identity. One issue can occupy two slots at once
/// after a team move: a session panel files it under the link's `DRA-53` while
/// the issues page files the same issue under `ENG-12`. Looking the body up by
/// the caller's spelling patched one of them and left the other drawing the old
/// status until the reconcile landed.
function patchCachedIssue(target: { identifier: string; id: string }, patch: IssuePatch): Rollback {
  const now = Date.now();
  const undo: (() => void)[] = [];

  for (const [slot, detail] of detailCache) {
    if (detail.id !== target.id) continue;

    undo.push(() => detailCache.set(slot, detail));
    detailCache.set(slot, patched(detail, patch));
    detailFetchedAt.set(slot, now);
  }

  for (const [key, issues] of cache) {
    if (!issues.some((issue) => issue.id === target.id)) continue;

    undo.push(() => cache.set(key, issues));

    // A status write can move a row out of the half its list asked for — Done
    // belongs to the settled read, not the open one. Patched in place it would
    // draw a second "Done" heading inside the open groups until the re-read
    // dropped it, so the row leaves here instead, which is what the answer will
    // say anyway. The half it moves *into* is left to the reconcile: it is a
    // row appearing late, never a wrong one on screen.
    const wantsSettled = settledOfKey(key);

    cache.set(
      key,
      issues.flatMap((issue) => {
        if (issue.id !== target.id) return [issue];
        const moved = patched(issue, patch);
        return isSettled(moved.state.kind) === wantsSettled ? [moved] : [];
      }),
    );
    fetchedAt.set(key, now);
  }

  // Repaint, not invalidate. The bump is also what refuses any read already in
  // flight, which is holding the generation it started under and would put the
  // pre-write answer back for the same reason.
  newIssueGeneration();

  return () => {
    for (const step of undo) step();

    // **Every stamp, not only the ones this write set.** A write that was
    // superseded left patches of its own that nothing now reverts — it declined
    // to, since a later write owned the screen — and those entries are stamped
    // fresh. Restoring this write's snapshot alone would leave them standing for
    // a minute with no read to correct them. The data is untouched, so nothing
    // blanks: every reader repaints what it holds and reads behind it.
    fetchedAt.clear();
    detailFetchedAt.clear();
    newIssueGeneration();
  };
}

/// Moves an issue's status or priority — the one write this app makes to a
/// tracker.
///
/// A module function rather than something a hook hands down, because both
/// surfaces that offer it are far from the hook that reads for them: the panel's
/// row header and the issues page's list rows. Threading a callback from `App`
/// through both would be two props for one function with no state behind it.
///
/// **Painted first, sent second.** The write is three Linear round trips deep —
/// the mutation, the read-back, and then every list re-reading — and a glyph
/// that does not move until all three land reads as a menu that ignored the
/// click. The reader picked a state this app already holds in full, so there is
/// nothing to wait for before showing it.
///
/// **Sent one at a time per issue, and only the request queues.** Firing both of
/// two quick picks at once leaves the tracker to decide which lands last, and it
/// need not be the one clicked last — so the server can end on A while the app
/// shows B, with nothing left to re-read and correct it. Chaining makes send
/// order the click order. The optimistic paint stays immediate, since it is
/// outside the chain.
///
/// **Only the last write in a chain settles anything.** An earlier one returning
/// with another still queued reconciles nothing and reports nothing: the screen
/// belongs to the later pick, and a card naming a decision the reader has already
/// replaced is noise.
///
/// **`issue.identifier` is the detail cache's key throughout, and the response's
/// own is never used for one.** They differ after a team move: a session linked
/// to `DRA-53` reads a detail that now calls itself `ENG-12`, and
/// `useSessionIssues` files it under the link's spelling. Keying the write off
/// the response would patch an entry nobody reads and file the answer where
/// nobody asks. The wire gets `issue.id`, the stable half, which is what Rust
/// looks up first anyway.
export async function updateIssue(issue: { identifier: string; id: string }, patch: IssuePatch) {
  outstanding.set(issue.id, (outstanding.get(issue.id) ?? 0) + 1);

  const rollback = patchCachedIssue(issue, patch);
  const prior = queues.get(issue.id) ?? Promise.resolve();
  const run = prior.then(() => send(issue, patch, rollback));

  // Swallowed on the *stored* handle only: a rejection left on the chain would
  // take down every write queued behind it, while `run` itself still carries the
  // failure to the caller.
  queues.set(issue.id, run.catch(() => {}));

  await run;
}

/// The request half, run in turn. Split out so the queueing above reads as
/// queueing and nothing else.
async function send(
  issue: { identifier: string; id: string },
  patch: IssuePatch,
  rollback: Rollback,
) {
  try {
    const next = await invoke<IssueDetail>("update_issue", {
      identifier: issue.identifier,
      id: issue.id,
      stateId: patch.state?.id ?? null,
      // `null` is "leave it" and `"none"` is a level in its own right, which is
      // why this cannot be a number: Linear spells no-priority `0`.
      priority: patch.priority ?? null,
    });

    if (!settles(issue.id)) return;

    forgetIssues();
    rememberDetail(issue.identifier, next, issueGeneration());
  } catch (e) {
    if (!settles(issue.id)) return;

    rollback();
    pushNotice({
      sessionId: issue.identifier,
      kind: "issue-failed",
      label: "Could not update",
      subject: issue.identifier,
      // The tracker's own words. A rejected key, an unreachable workspace and a
      // state belonging to another team each need a different thing done about
      // them, and only the sentence tells them apart.
      // By shape, since a write names one issue and nothing here was told which
      // tracker it belongs to.
      detail: issueErrorText(asUnavailable(e), trackerOf(issue.identifier)),
    });
  } finally {
    released(issue.id);
  }
}

/// A failed write in one line, in terms of what the reader would do about it.
///
/// **The two sentences that name Linear are drawn for Linear alone.** A stored
/// key and an unreachable GraphQL API are Linear's failures; GitHub's
/// credential is `gh`'s own and there is nothing in Settings to disconnect, so
/// telling a reader to go and re-paste a key they never pasted sends them to do
/// nothing. Everything else is already tracker-neutral, and `other` carries the
/// CLI's or the API's own words either way.
export function issueErrorText(error: IssueUnavailable, tracker: IssueTracker = "linear"): string {
  const linear = tracker === "linear";

  switch (error.kind) {
    case "unauthorized":
      return linear
        ? "Linear rejected the saved key. Disconnect it in Settings, then paste a new one."
        : "GitHub refused that read. Sign in again with `gh auth login`.";
    case "offline":
      return linear ? "Could not reach Linear." : "Could not reach GitHub.";
    case "not_connected":
      return linear
        ? "No issue tracker connected."
        : "Not signed in to GitHub. Run `gh auth login`.";
    default:
      return error.detail;
  }
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

/// The resting question, for whichever tracker is up.
///
/// **`teamId` is the repository under GitHub**, and it is read from the
/// reader's own stored pick rather than left null: a number is only addressable
/// within a repository, so a null there is not "every repo" but "nothing to
/// read", which is what the page's own empty state says.
const defaultQuery = (tracker: IssueQuery["tracker"]): IssueQuery => ({
  tracker,
  text: null,
  // The default is the useful one: what this person is meant to be working on.
  scope: "assigned",
  teamId: tracker === "github" ? readIssueRepo() : null,
  projectId: null,
  label: null,
  settled: false,
});

/// One list read, cached and debounced. The page runs two of these.
///
/// `enabled` is what makes the settled half free: a read that is never asked
/// for costs nothing, so the done and cancelled groups can be drawn collapsed
/// with no round trip behind them until somebody opens one.
function useIssueList(query: IssueQuery, enabled: boolean, generation: number) {
  const key = keyOf(query);

  // Subscribed, not merely read — the same bargain `useSessionIssues` makes.
  // A connection changing under the page, or a status written in the pane
  // beside this list, both land as a generation bump, and without this the row
  // keeps saying "Backlog" under a heading the issue has just left.
  const connection = useSyncExternalStore(subscribeIssueGeneration, issueGeneration);

  const [issues, setIssues] = useState<Issue[]>(() => cache.get(key) ?? []);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState<IssueUnavailable | null>(null);
  /// Whether this list has ever answered. Distinct from `issues.length`, which
  /// cannot tell "nothing here" from "not asked yet" — and the two draw
  /// differently on a group header that has no count to show until it has.
  const [answered, setAnswered] = useState(() => cache.has(key));

  /// Which tracker the rows above came from.
  ///
  /// **Rows outlive a key change on purpose** — typing in the search box makes
  /// a key nothing is cached under on every keystroke, and blanking the list
  /// under the reader each time is the flicker this cache exists to remove. A
  /// *tracker* change is the one key change where that is wrong: the rows are
  /// another workspace's, the headings above them have already changed, and a
  /// read that then fails leaves Linear's issues sitting under GitHub's error.
  /// So this is dropped by tracker alone, and every other key change still
  /// paints through.
  const [shownTracker, setShownTracker] = useState(query.tracker);

  if (shownTracker !== query.tracker) {
    // During render rather than in an effect, which lands after paint: the
    // frame in between is exactly the one that draws the wrong tracker's rows.
    setShownTracker(query.tracker);
    setIssues(cache.get(key) ?? []);
    setAnswered(cache.has(key));
    setUnavailable(null);
  }

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
      invoke<Issue[]>("list_issues", { query, limit: ISSUE_LIST_LIMIT })
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
  }, [enabled, key, query, generation, connection]);

  return { issues, loading, unavailable, loaded: answered };
}

/// The issues page's lists, its filter row's options, and the state of the read.
///
/// Filters live here rather than in the view so the read and the controls that
/// change it cannot disagree about what is on screen — the page draws what this
/// answers and owns none of it.
export function useIssues(active: boolean, tracker: IssueQuery["tracker"] = "linear") {
  const [query, setQuery] = useState<IssueQuery>(() => defaultQuery(tracker));
  const [filters, setFilters] = useState<IssueFilters | null>(null);

  // A tracker switch is a different workspace, so both the narrowing and the
  // options it was built from stop meaning anything: a Linear team id under
  // GitHub names no repository, and the filter menu would go on offering teams
  // that are not there. Reset during render rather than in an effect, the
  // reading `useSessionIssues` takes — an effect is a frame behind, and that
  // frame reads Linear's list under GitHub's chip.
  if (query.tracker !== tracker) {
    setQuery(defaultQuery(tracker));
    setFilters(null);
  }
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

  // The query's own `settled`, not a forced `false`: GitHub has two states and
  // a switch picks between them, so *this* is the list on screen. Linear leaves
  // the field at its default and reads its finished work through the settled
  // groups below instead, which is what its five-state workflow wants.
  const openQuery = query;
  const settledQuery = useMemo(() => ({ ...query, settled: true }), [query]);

  const open = useIssueList(openQuery, active, generation);
  // **Linear's alone.** `wantSettled` is sticky for the life of the page, so
  // without the harness check a reader who had ever opened a Done group went on
  // paying a second `gh` spawn behind every GitHub query — for a list GitHub
  // never draws, its finished work being the state switch's other half. One
  // wasted `gh` per query is not nothing: that budget is per user and every
  // agent in every session spends it too.
  const settled = useIssueList(
    settledQuery,
    active && wantSettled && tracker === "linear",
    generation,
  );

  /// Which repository the options on hand describe.
  ///
  /// Teams and projects change on the timescale of somebody reorganising a
  /// workspace, so this is read once per visit — but **labels belong to one
  /// repository**, so the read has to move when the repository does or the menu
  /// offers another repo's vocabulary. Held rather than folded into `filters`,
  /// which is null while the read is out and would re-arm this on itself.
  const [filtersRepo, setFiltersRepo] = useState<string | null>(query.teamId);
  const wantedRepo = tracker === "github" ? query.teamId : null;
  const staleFilters = filters !== null && filtersRepo !== wantedRepo;

  useEffect(() => {
    if (!active || (filters && !staleFilters)) return;

    let live = true;
    invoke<IssueFilters>("list_issue_filters", { tracker, repo: wantedRepo })
      .then((next) => {
        if (!live) return;
        setFilters(next);
        setFiltersRepo(wantedRepo);
      })
      // Silent: with no filters the row simply offers less, and the list above
      // has already said whatever went wrong.
      .catch(() => {});

    return () => {
      live = false;
    };
  }, [active, filters, staleFilters, wantedRepo, generation, tracker]);

  return {
    issues: open.issues,
    filters,
    query,
    /// Every change to the query goes through here, which is what makes the
    /// repository pick persist: `teamId` under GitHub *is* the repository, and
    /// the page is opened again far more often than it is filtered, so
    /// forgetting it would mean picking a repo on every visit.
    setQuery: useCallback(
      (next: IssueQuery) => {
        if (next.tracker === "github") setIssueRepo(next.teamId);
        setQuery(next);
      },
      [],
    ),
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
