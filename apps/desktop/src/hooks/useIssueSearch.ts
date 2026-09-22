import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import { cachedIssues, ISSUE_LIST_LIMIT, rememberIssues } from "@/hooks/useIssues";
import { filterIssues, issueGeneration } from "@/lib/issue";

import type { Issue, IssueQuery, IssueTracker } from "@/types/events";

/// How deep the picker's list goes. The backend ranks by priority, so this is
/// the depth somebody might scroll before typing another character rather than
/// an attempt to show everything that matched.
///
/// A display depth alone — the *read* asks for `ISSUE_LIST_LIMIT`, since the
/// list cache is keyed on the query and not on how far it was read, so a
/// shallower read here would file a truncated answer under the key the issues
/// page paints from.
const LIMIT = 25;

/// Longer than the file picker's 60ms, and for a different reason: that one is
/// spacing out an IPC hop over an in-memory index, and this is a round trip to
/// Linear. Every keystroke that reaches the network is one the reader waits on.
const DEBOUNCE_MS = 200;

/// The picker's question with `text` filled in. The picker is "what am I working
/// on", which is the assigned and unfinished list — widening lives on the issues
/// page, where there is room for a filter row to say what it is doing.
///
/// Which also makes the empty-text shape the issues page's own default query, so
/// the two share cache entries rather than each paying for the same read.
/// **Under GitHub the picker reads this session's own repository and nothing
/// else.** A number is only addressable within one, and the composer already
/// knows which repository it is in — where the issues page has to be told,
/// being workspace-wide. So the slug is the query's `teamId`, and with none the
/// picker has nothing it could honestly list.
/// **The scope differs by tracker, and that is not a quirk.** Linear's list is
/// workspace-wide, so "assigned to me" is what makes it a list rather than a
/// firehose. GitHub's is already narrowed to *one repository* by the session's
/// own checkout, so the same clause narrows a small list to almost nothing:
/// assigning yourself an issue is a habit far fewer repositories have than
/// Linear workspaces do, and the picker opened empty on repositories with
/// plenty of open work in them.
const queryFor = (text: string, tracker: IssueTracker, repo: string | null): IssueQuery => ({
  tracker,
  text: text || null,
  scope: tracker === "github" ? "all" : "assigned",
  teamId: tracker === "github" ? repo : null,
  projectId: null,
  settled: false,
});

/// What an empty picker says, in terms of why it is empty.
///
/// Three different facts, and collapsing them into one sentence would leave the
/// reader unable to tell a repository this app cannot find from one that simply
/// has no open issues — the first is fixed by switching tracker, the second by
/// nothing at all.
function emptyNote(github: boolean, repo: string | null | undefined, query: string): string {
  if (github && repo === null) return "No GitHub repository here.";
  if (query.trim()) return "No issue matches that.";

  return github ? "No open issues in this repository." : "Nothing assigned to you.";
}

/// `owner/repo` per directory, for the life of the process.
///
/// A remote does not move while the app is running — the same bargain
/// `repo_slug` makes on the PR side — and this is read on the keystroke that
/// opens the picker, where an IPC hop is a frame the menu does not open in.
const repos = new Map<string, string | null>();

async function repoFor(cwd: string): Promise<string | null> {
  const held = repos.get(cwd);
  if (held !== undefined) return held;

  const repo = await invoke<string | null>("github_repo", { cwd }).catch(() => null);
  repos.set(cwd, repo);

  return repo;
}

/// Issues matching `query`, best first, and whether a read is in flight — or an
/// empty list while the picker is closed.
///
/// `query` is `null` when the caret isn't in a tag, which is what closes the
/// picker — passed rather than the hook being called conditionally, since hooks
/// cannot be.
///
/// Shaped like [useFileSearch](./useFileSearch.ts) deliberately: the composer
/// reads both the same way, and a second shape would be a second set of
/// race-and-debounce rules to get right. The one thing it does not share is the
/// cache: that one is an in-memory index and free to ask, where every read here
/// is a round trip to Linear — so this paints from
/// [useIssues](./useIssues.ts)'s cache first and lets the network correct it.
///
/// `loading` is what the file picker has no use for and this one does: a cold
/// `#` has nothing cached to paint and no index to ask, so the menu draws
/// placeholder rows rather than staying shut until Linear answers.
export function useIssueSearch(
  query: string | null,
  tracker: IssueTracker = "linear",
  cwd: string | null = null,
): { issues: Issue[]; loading: boolean; emptyNote?: string } {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  /// The session's own repository under GitHub, once it has been asked for.
  /// `undefined` while it has not been — which is distinct from `null`, the
  /// answer that there is no GitHub remote here, and the two draw differently.
  /// The answer, **with the directory it was asked about**. Kept together and
  /// read apart during render, the reading `useSessionIssues` takes: held as a
  /// bare slug it went on naming the *previous* session's repository for as
  /// long as the new lookup took, and a `#` typed in that window listed session
  /// A's issues into session B's prompt — one composer, one module cache, and
  /// nothing tying the value to the question it answered.
  const [resolved, setResolved] = useState<{ cwd: string; repo: string | null } | null>(null);
  /// Whether anything is on screen to protect. A first read has nothing to wait
  /// for, so it skips the debounce and the picker never opens blank.
  const showing = useRef(false);

  const github = tracker === "github";

  /// `null` where there is nothing to resolve, `undefined` while this
  /// directory's answer is still out, and the slug once it lands. The three
  /// draw differently and the middle one must never be mistaken for either.
  const repo = !github || !cwd ? null : resolved?.cwd === cwd ? resolved.repo : undefined;

  /// Which tracker the rows below came from — the issues page's own guard, and
  /// the same reason for it. Rows outlive a keystroke on purpose, so the list
  /// does not blank under somebody mid-word; they must not outlive a *tracker*
  /// switch, where they are another workspace's issues sitting under the chips
  /// that just moved.
  const [shownTracker, setShownTracker] = useState(tracker);

  if (shownTracker !== tracker) {
    setShownTracker(tracker);
    setIssues([]);
    showing.current = false;
  }

  // Asked once per directory and cached across mounts, so the answer is usually
  // already in hand by the time a `#` is typed.
  useEffect(() => {
    if (!github || !cwd) return;

    let live = true;
    void repoFor(cwd).then((next) => live && setResolved({ cwd, repo: next }));

    return () => {
      live = false;
    };
  }, [github, cwd]);

  useEffect(() => {
    if (query === null) {
      setIssues([]);
      setLoading(false);
      showing.current = false;
      return;
    }

    // Nothing to read: this session is not in a GitHub checkout, or the answer
    // has not landed yet. The menu says so rather than listing another
    // repository's issues, which is what a null `teamId` would have it do.
    if (github && !repo) {
      setIssues([]);
      setLoading(repo === undefined);
      showing.current = false;
      return;
    }

    // Guards out-of-order replies as well as unmounting: two reads in flight
    // can land either way round, and the older one landing last would leave the
    // list describing a query already typed past.
    let cancelled = false;

    // Captured before anything is read, not when an answer lands — the same
    // guard `useIssueList` makes, and for the same reason: a connection
    // changing under this read must refuse its write rather than re-stamp it.
    const reading = issueGeneration();

    // What can be answered without the network, best first: this exact query if
    // it has been asked before, else the whole assigned list narrowed here.
    // Either is on screen for the frame the keystroke lands in, which is the
    // whole point — the read below then replaces it, since Linear matches
    // descriptions and this cannot.
    const exact = cachedIssues(queryFor(query, tracker, repo ?? null));
    const base = query ? cachedIssues(queryFor("", tracker, repo ?? null)) : undefined;
    const painted = exact?.issues ?? (base && filterIssues(base.issues, query));
    if (painted) {
      setIssues(painted.slice(0, LIMIT));
      showing.current = true;
    }

    // A fresh answer to this exact question is the whole answer, so nothing is
    // read: that is what makes a second `#` open from memory. The issues page's
    // own 60s window decides it, since the two are filling one cache.
    //
    // Clearing `loading` here is not belt and braces — it is the only path that
    // clears it with no request having finished, and a read cancelled by the
    // next keystroke never reaches its own `finally`. Without it, backspacing
    // onto a cached query leaves placeholder rows under a list already right.
    if (exact?.fresh) {
      setLoading(false);
      return;
    }

    setLoading(true);

    const asked = queryFor(query, tracker, repo ?? null);

    const run = () => {
      invoke<Issue[]>("list_issues", { query: asked, limit: ISSUE_LIST_LIMIT })
        .then((matches) => {
          // Filed whether or not this read still has a picker to draw into: the
          // answer is as true for the next `#` as for this one, and the reader
          // typing past it is the ordinary way a read gets cancelled.
          rememberIssues(asked, matches, reading);
          if (cancelled) return;
          setIssues(matches.slice(0, LIMIT));
          showing.current = true;
        })
        // The list is left as it was rather than cleared: a failed refresh must
        // not empty a list somebody is reading, and there is nothing to say
        // here anyway — a picker is not where "Linear is down" belongs.
        .catch((e) => console.error("[issue search]", e))
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    if (!showing.current) {
      run();
      return () => {
        cancelled = true;
      };
    }

    const timer = setTimeout(run, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, tracker, repo, github]);

  return {
    issues,
    loading,
    // **An empty answer is a sentence, never a closed menu**, and that is the
    // opposite reading to the `/` picker's next door. There, a query matching
    // nothing closes quietly because the list is already on screen and its
    // emptiness needs no narrating. Here the menu never opened at all — so a
    // tracker with nothing to list was indistinguishable from `#` being broken,
    // and it took the tracker chips with it, which are the one control that
    // reaches the tracker that *does* have issues. Withheld only while a read
    // is still out, where placeholder rows already say the list is coming.
    emptyNote:
      query === null || loading || issues.length > 0
        ? undefined
        : emptyNote(github, repo, query),
  };
}
