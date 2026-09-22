import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type SyntheticEvent,
} from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Tag,
} from "lucide-react";

import Avatar from "@/components/Avatar";
import { PriorityMenu, StatusMenu } from "@/components/IssueMenus";
import IssueLabelChip from "@/components/IssueLabelChip";
import IssueStateIcon from "@/components/IssueStateIcon";
import Segmented from "@/components/Segmented";
import LinearIcon from "@/components/LinearIcon";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import ShortcutKeys from "@/components/ShortcutKeys";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import GitHubIcon from "@/components/GitHubIcon";
import IssueTrackerChips from "@/components/IssueTrackerChips";
import { useHotkey } from "@/hooks/useHotkey";
import { issueErrorText, useIssues } from "@/hooks/useIssues";
import { groupIssues, groupLabel, shortIdentifier } from "@/lib/issue";
import {
  readIssueTracker,
  subscribeIssueTracker,
  type Connected,
} from "@/lib/issueTracker";
import { calendarDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  Issue,
  IssueGroup,
  IssueLabel,
  IssueQuery,
  IssueScope,
  IssueState,
  IssueStateKind,
  IssueTracker,
} from "@/types/events";

/// The page's search field. Named so ⌘⇧F can reach it — the same trick the
/// sidebar's own field uses, and for the same reason: the chord has to be able
/// to *re-focus* a field already on screen, which a `ref` threaded up through
/// the page would do no better.
///
/// **Shifted, where the sidebar's is not.** ⌘F belongs to the sidebar and is
/// bound app-wide, so a second field claiming it would take the one search that
/// works from anywhere and make it depend on which view is up.
const ISSUE_SEARCH_INPUT_ID = "issues-search";

/// Where a personal API key is made. Linked rather than described, because the
/// path through Linear's own settings is theirs to change and a stale sentence
/// here is worse than none.
const LINEAR_KEYS_URL = "https://linear.app/settings/account/security";

/// Linear's own MCP documentation. The setup is theirs and it changes, so this
/// points at it rather than reproducing it.
const LINEAR_MCP_URL = "https://linear.app/docs/mcp";

/// Where GitHub's own instructions for signing `gh` in live. Linked rather
/// than described, for the reason the Linear key link is: the flow is theirs to
/// change.
const GH_AUTH_URL = "https://cli.github.com/manual/gh_auth_login";

/// Said in the CLI's own words, and Homebrew because this app is macOS only and
/// that is how `gh` arrives here. Spelled exactly as the PR panel's setup pane
/// spells it — the two are one machine's answer to one question, and a reader
/// meeting both should not find two vocabularies for it.
const LOGIN_COMMAND = "gh auth login";
const INSTALL_COMMAND = "brew install gh";

/// The two questions worth one press, and the second one differs by tracker.
///
/// Linear's list is workspace-wide, so "what did I file" is a real second
/// question and "everything" would be a firehose. **GitHub's is already one
/// repository**, so the useful pair there is what is mine and what is *there* —
/// "Created" narrows a list the reader has already narrowed by hand, to the
/// handful they happened to open themselves, which is a smaller question than
/// anybody opens this page to ask.
const SCOPES: Record<IssueTracker, { value: IssueScope; label: string }[]> = {
  linear: [
    { value: "assigned", label: "Assigned to me" },
    { value: "created", label: "Created" },
  ],
  github: [
    { value: "assigned", label: "Assigned to me" },
    { value: "all", label: "All" },
  ],
};

/// GitHub's two states, as a switch rather than as two headings.
///
/// **It has exactly two, which is what makes a heading per state the wrong
/// shape there.** Linear's five are a workflow and a page grouped by them says
/// what is moving; GitHub's are open and closed, so the same grouping drew one
/// list under a heading and a permanently-collapsed second heading under it,
/// which is a switch wearing a costume. This is the switch. Closed work is a
/// different question rather than the tail of this one, so asking it swaps the
/// list instead of growing it.
const STATES = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
] as const;

/// The two buckets that are read on demand. Drawn in the same order [groupIssues]
/// would put them in, so opening one does not reshuffle the page.
const SETTLED_KINDS: { key: IssueStateKind; label: string }[] = [
  { key: "completed", label: "Done" },
  { key: "canceled", label: "Cancelled" },
];

/// Every issue the reader could pick up.
///
/// A page rather than a panel: the right-hand panel answers "what is *this*
/// session about", and this answers "what is there to work on" — which has no
/// session to hang off and is the thing you look at before there is one.
///
/// Clicking a row opens it in the pane beside the list, where its status and
/// its priority can be moved. Everything else about an issue — its text, its
/// people, its conversation — is still the tracker's to edit, and ⌘-clicking a
/// row is the shortcut there.
export default function IssuesView({
  active,
  connected,
  onConnect,
  connecting,
  connectError,
  onRecheckGithub,
  picked,
  onPick,
  onWorkOn,
  refreshRef,
}: {
  /// The page is the thing on screen. Hidden pages do not read, for the reason
  /// the right panel's own `active` exists.
  active: boolean;
  /// Which trackers have something behind them — not whether *a* tracker does.
  /// The chips are drawn only where both do, and the pick resolves against it.
  connected: Connected;
  /// Answers whether the key was accepted, so the field can clear itself only
  /// on success.
  onConnect: (key: string) => Promise<boolean>;
  connecting: boolean;
  connectError: string | null;
  /// Re-asks whether `gh` is there and signed in. The GitHub connect pane's one
  /// control, and the only way off that pane short of relaunching the app.
  onRecheckGithub: () => Promise<void>;
  /// The issue whose detail the pane beside this is showing, so the row can
  /// say which one it is. Owned by `App`, because the pane is.
  picked: string | null;
  onPick: (issue: Issue) => void;
  /// Takes the reader to the empty composer with this issue tagged. Owned by
  /// `App`, which is the only thing that can leave this page.
  onWorkOn: (issue: Issue) => void;
  /// Where this page hands its refresh up, so ⌘R can reach it. `App` owns the
  /// chord — it has to pick between this page and the right panel, and only it
  /// knows which one the reader is looking at.
  refreshRef?: MutableRefObject<(() => void) | null>;
}) {
  // **The pick is honoured, connected or not**, where this used to be resolved
  // against what was actually behind it. The switch below is drawn either way
  // now — it is the only thing in the app that says a second tracker exists, so
  // hiding it left the pitch for one on a screen reachable only by having
  // neither — and a switch whose press is silently undone is worse than none.
  // What a disconnected pick draws is that tracker's own connect pane, which is
  // where the press was going anyway.
  const tracker = useSyncExternalStore(subscribeIssueTracker, readIssueTracker);

  /// Whether the tracker on screen has nothing behind it. Asked of the *picked*
  /// one alone: what the other half has says nothing about what this list can
  /// read, and with one connected this is the ordinary state of the other.
  const needsConnecting = !connected[tracker];

  const { issues, settled, filters, query, setQuery, loading, loaded, unavailable, refresh } =
    useIssues(active && !needsConnecting, tracker);

  // Kept current rather than set once: `refresh` is re-made whenever the hook
  // re-runs, and a handle captured at mount would close over a stale one.
  useEffect(() => {
    if (!refreshRef) return;
    refreshRef.current = refresh;
    return () => {
      refreshRef.current = null;
    };
  }, [refreshRef, refresh]);

  const set = (patch: Partial<IssueQuery>) => setQuery({ ...query, ...patch });

  // Bound here rather than in `App`, unlike ⌘F: this field only exists while
  // the page does, and `enabled` unregisters the listener outright rather than
  // leaving a chord claimed — `useHotkey` calls `preventDefault` on every match,
  // so a binding left standing would eat ⌘⇧F from whatever *is* on screen.
  // `select` rather than `focus`, so pressing it on a query replaces it.
  useHotkey(
    "issues.search",
    () => document.querySelector<HTMLInputElement>(`#${ISSUE_SEARCH_INPUT_ID}`)?.select(),
    { enabled: active && !needsConnecting },
  );

  /// The workflow a row's status menu offers, which belongs to the issue's own
  /// team. Read once per connection with the filter options rather than per
  /// issue — a team's states are the same answer for every row it owns, so
  /// asking for them on the list read would repeat one workflow a hundred times
  /// down the wire. Empty until that read lands, which draws a plain glyph.
  const statesFor = (issue: Issue) =>
    (issue.team && filters?.teamStates[issue.team]) || [];
  /// Whether the GitHub half has nothing it could read. Not an error and not a
  /// failed read — the page simply has no repository named yet, which is the
  /// state it opens in the first time.
  const needsRepo = tracker === "github" && !query.teamId;

  /// The settled headings in the tracker's own words. The *kinds* are shared —
  /// which is what lets one page group both — where "Done" and "Cancelled" are
  /// Linear's vocabulary and would read as some other tracker's workspace over
  /// a list of GitHub issues.
  const settledKinds = useMemo(
    () =>
      SETTLED_KINDS.map(({ key }) => ({ key, label: groupLabel(key) })),
    [],
  );

  // Linear's alone: GitHub draws its rows flat under the state switch.
  const groups = useMemo(() => groupIssues(issues), [issues]);
  const settledGroups = useMemo(() => groupIssues(settled.issues), [settled.issues]);

  if (needsConnecting) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* The list's own row, cut to the one control that still means
            anything: everything else there narrows a list nothing is reading.
            Its place is what keeps the two states one page rather than two —
            the switch does not move when a press lands on it. */}
        <div className="flex shrink-0 items-center px-3 pt-3">
          <IssueTrackerChips tracker={tracker} />
        </div>

        <Connect
          tracker={tracker}
          connected={connected}
          onConnect={onConnect}
          onRecheckGithub={onRecheckGithub}
          busy={connecting}
          error={connectError}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* **Wraps, and nothing in it shrinks.** Every control here is a pill
          whose width is its own text, so a row that will not wrap has only one
          way to fit them — squeeze them — which broke "Assigned to me" over two
          lines and pushed the repository and label controls off the pane where
          the panel was open. `ml-auto` still holds the narrowing group to the
          right edge of the first line, and starts at the left of the second
          — see the spacer below. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pt-3">
        {/* First in the row, because it changes what every other control in it
            means: the scopes and the filter menu narrow *within* a tracker.
            **Always drawn**, the disconnected half included — it is the only
            place the app says a second tracker exists, and pressing it is how
            somebody finds that out. */}
        <IssueTrackerChips tracker={tracker} className="mr-1" />

        {SCOPES[tracker].map((scope) => (
          // Chips rather than a menu, because these are the two questions worth
          // one press: what is mine to do, and what did I ask for. Everything
          // that narrows *within* an answer is behind the control beside them.
          <button
            key={scope.value}
            type="button"
            onClick={() => set({ scope: scope.value })}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-ui transition-colors",
              query.scope === scope.value
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {scope.label}
          </button>
        ))}

        {tracker === "github" && (
          <Segmented
            value={query.settled ? "closed" : "open"}
            options={STATES}
            onPick={(state) => set({ settled: state === "closed" })}
            label="Issue state"
            className="ml-1"
          />
        )}

        {/* **What the page *is* stays left; what narrows it goes right.** The
            chips answer "whose issues" and are a pick out of a fixed pair; the
            controls over here each carry a value of their own and grow as wide
            as it is, so interleaved they pushed the chips a different distance
            from the edge on every repository. Refresh closes the group and is
            *inside* it: left as a sibling it was the one thing narrow enough to
            fit on its own, so a row an icon's width too long wrapped a lone
            spinner onto a second line under a first that still looked full.

            **The repository is a control on the row, not a row in a menu.** It
            is not a filter narrowing a list the page can already draw — under
            GitHub it *is* the list, so with none picked there is nothing on
            screen at all. Buried behind the sliders icon it was both invisible
            when set and unfindable when not, and the label filter beside it was
            the same story one menu deeper. */}
        {/* A growing spacer rather than `ml-auto` on the group, and the
            difference is what happens on the *second* line. `ml-auto` is the
            group's own margin, so it right-aligns it wherever it lands and a
            wrapped group hung off the right edge with the whole line empty
            beside it. This is a flex item of its own at `flex-basis: 0`, so it
            counts for nothing when the browser decides where to break and then
            eats whatever the first line has left — which puts the group at the
            right while it fits and at the left once it does not. */}
        <div className="flex-1" aria-hidden />

        <div className="flex shrink-0 items-center gap-1.5">
          {tracker === "github" && (
            <>
              <RepoMenu
                repo={query.teamId}
                repos={filters?.teams ?? []}
                // The label goes with it: labels belong to the repository, so a
                // pick carried across would narrow the new list by a name it
                // has never heard of and draw nothing, with a lit control as
                // the only clue why.
                onPick={(teamId) => set({ teamId, label: null })}
              />
              <LabelMenu
                label={query.label}
                labels={filters?.labels ?? []}
                onPick={(label) => set({ label })}
              />
            </>
          )}

          <FilterMenu query={query} filters={filters} tracker={tracker} onChange={set} />

          {/* Last, and it narrows nothing — same corner and same chord as the
              right panel's, which is the point: the chord means "re-read what I
              am looking at", and never a specific thing. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh"
                className="text-muted-foreground/60 hover:text-muted-foreground"
                onClick={refresh}
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              Refresh
              <ShortcutKeys ids={["panel.refresh"]} />
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* No fill and no border. A search box is the one control here that is
          always in the same place, so it needs no edge to be found — and a
          filled field above a borderless list draws a box round the least
          interesting third of the page. The glyph does the work the border
          was doing: it says "type here" without enclosing anything. */}
      <div className="group flex h-11 shrink-0 items-center gap-2 px-3">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <Input
          id={ISSUE_SEARCH_INPUT_ID}
          value={query.text ?? ""}
          placeholder="Search issues"
          spellCheck={false}
          // `dark:bg-transparent` as well as `bg-transparent`: the base input
          // carries `dark:bg-input/30`, which is the more specific rule and
          // wins — so the plain override read as removed here while leaving a
          // fill on screen.
          className="h-full rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(e) => set({ text: e.currentTarget.value || null })}
          // Escape drops the query, the sidebar's rule. It does *not* blur:
          // this field is always drawn, so there is nothing to close and a
          // caret left where it was is a second search ready to be typed.
          onKeyDown={(e) => {
            if (e.key !== "Escape" || !query.text) return;
            e.preventDefault();
            set({ text: null });
          }}
        />

        {/* The slot names whichever key does something here, and which one that
            is turns on focus alone — the sidebar's rule, and the two fields
            should not need learning twice. Escape reaches this input and
            nothing else; ⌘⇧F is what brings focus back to a field left holding
            a query. Esc is withheld over an empty field, the one state neither
            key has anything to do in. */}
        {query.text && <Kbd className="hidden group-focus-within:inline-flex">Esc</Kbd>}
        <ShortcutKeys ids={["issues.search"]} className="group-focus-within:hidden" />
      </div>

      {/* Under the header rather than over the rows: a failed refresh leaves
          what was already read on screen, and this says the answer is stale. */}
      {unavailable && (
        <p className="border-b border-border px-3 py-2 text-ui text-destructive">
          {issueErrorText(unavailable, tracker)}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* **Nothing is read until a repository is picked**, and that is the
            GitHub half's own resting state rather than a failure: an issue
            number means nothing without one, and reading every attached project
            would be a `gh` spawn per repo for a list nobody asked for. Above the
            reading line, since there is no read to report on. */}
        {needsRepo ? (
          // **The repositories are the empty state, not a sentence about
          // them.** "Choose a repository" with no repositories on screen is an
          // instruction the reader then has to go and work out how to follow —
          // and the control that would have answered it was a row inside a menu
          // behind a glyph. The list this page cannot draw without is the one
          // thing worth putting in the space where that list goes.
          <div className="flex flex-col items-start gap-1 px-3 py-4">
            {filters === null ? (
              <p className="text-ui text-muted-foreground">Reading…</p>
            ) : filters.teams.length > 0 ? (
              <>
                <p className="pb-1 text-ui text-muted-foreground">
                  Choose a repository to see its issues.
                </p>
                {filters.teams.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => set({ teamId: option.id })}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-ui transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  >
                    <GitHubIcon className="size-3.5 text-muted-foreground" />
                    {option.name}
                  </button>
                ))}
              </>
            ) : (
              // The cure is attaching a project, which happens elsewhere — so
              // this one stays a sentence, and names what makes a project
              // count rather than leaving the reader to guess.
              <p className="text-ui text-muted-foreground">
                Attach a project with a GitHub remote to see its issues.
              </p>
            )}
          </div>
        ) : (
          <>
            {/* Nothing else while the first read is out — not even the settled
                headings, which are the one part of this list that can be drawn
                without an answer and so were the only thing on screen. A page
                whose finished work appears first, and whose open work arrives
                second, reads as a workspace with nothing left to do. */}
            {!loaded && <p className="px-3 py-2 text-ui text-muted-foreground">Reading…</p>}

            {loaded && issues.length === 0 && !loading && (
              <p className="px-3 py-4 text-ui text-muted-foreground">
                {query.text
                  ? "No issue matches that."
                  : query.settled
                    ? query.scope === "all"
                      ? "No closed issues in this repository."
                      : "Nothing closed is assigned to you."
                    : query.scope === "created"
                      ? "Nothing you filed is open."
                      : query.scope === "all"
                        ? "No open issues in this repository."
                        : "Nothing assigned to you."}
              </p>
            )}

            {/* **No headings under GitHub**, since the switch above already
                says which of its two states is on screen and a lone "Open" over
                every row is that sentence a second time. Linear keeps them: its
                five are a workflow, and the split between what is moving and
                what is waiting is most of what the page is for. */}
            {loaded && tracker === "github"
              ? issues.map((issue) => (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    picked={issue.identifier === picked}
                    scopedToMe={query.scope === "assigned"}
                    states={statesFor(issue)}
                    onPick={onPick}
                    onWorkOn={onWorkOn}
                  />
                ))
              : loaded &&
                groups.map((group) => (
                  <Group
                    key={group.key}
                    kind={group.key}
                    label={group.label}
                    count={group.issues.length}
                  >
                    {group.issues.map((issue) => (
                      <IssueRow
                        key={issue.id}
                        issue={issue}
                        picked={issue.identifier === picked}
                        scopedToMe={query.scope === "assigned"}
                        states={statesFor(issue)}
                        onPick={onPick}
                        onWorkOn={onWorkOn}
                      />
                    ))}
                  </Group>
                ))}

            {/* Done and Cancelled are always here and always start closed.
                Finished work is most of a workspace and almost never what the
                page was opened for — but it is what the reader wants when they
                want it, and a filter they have to find first is worse than a
                heading they can see. Nothing is fetched until one is opened:
                the headings cost a round trip only when somebody asks a
                question of them. */}
            {loaded &&
              tracker !== "github" &&
              settledKinds.map(({ key, label }) => {
                const group = settledGroups.find((g) => g.key === key);

                return (
                  <Group
                    key={key}
                    kind={key}
                    label={label}
                    count={settled.loaded ? (group?.issues.length ?? 0) : null}
                    collapsedByDefault
                    onFirstOpen={settled.request}
                  >
                    {settled.loading && !settled.loaded ? (
                      <p className="px-3 py-2 text-ui text-muted-foreground">Reading…</p>
                    ) : group ? (
                      group.issues.map((issue) => (
                        <IssueRow
                          key={issue.id}
                          issue={issue}
                          picked={issue.identifier === picked}
                          scopedToMe={query.scope === "assigned"}
                          states={statesFor(issue)}
                          onPick={onPick}
                          onWorkOn={onWorkOn}
                        />
                      ))
                    ) : (
                      <p className="px-3 py-2 text-ui text-muted-foreground">Nothing here.</p>
                    )}
                  </Group>
                );
              })}
          </>
        )}
      </div>
    </div>
  );
}

/// The pane for a tracker with nothing behind it, and the thing that fixes it
/// lives *here* rather than a trip to settings — this is the surface that has
/// nothing to show without one, so this is where the cure belongs.
///
/// **It answers for one tracker at a time**, the one the switch above is on,
/// since pressing that switch is what asked the question. The other is offered
/// under a rule and only while it is *also* unconnected: pitching a tracker
/// somebody already has can only read as the app being confused about it.
function Connect({
  tracker,
  connected,
  onConnect,
  onRecheckGithub,
  busy,
  error,
}: {
  tracker: IssueTracker;
  connected: Connected;
  onConnect: (key: string) => Promise<boolean>;
  onRecheckGithub: () => Promise<void>;
  busy: boolean;
  error: string | null;
}) {
  const [key, setKey] = useState("");

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
      <div className="flex w-full max-w-sm flex-col gap-3">
        {tracker === "linear" ? (
          <>
            <div className="flex flex-col gap-1">
              {/* The mark, because it is what makes this recognisable before
                  the sentence under it is read — and this is one of the two
                  places in the app where naming the tracker is the point
                  rather than a leak of the implementation. */}
              <p className="flex items-center gap-2 text-ui font-medium">
                <LinearIcon />
                Connect Linear
              </p>
              {/* The smaller ask is still offered, and second: read alone is
                  what somebody wary of pasting a credential into a desktop app
                  can give, and naming it is what keeps that a small decision.
                  Write is named first because it is what the app now does, and
                  leaving it out would have the reader find out from a status
                  menu that fails. */}
              <p className="text-ui text-muted-foreground">
                Paste a personal API key with read and write access. A read-only key works too —
                you just cannot change a status or priority.
              </p>
            </div>

            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await onConnect(key)) setKey("");
              }}
            >
              <Input
                value={key}
                // A personal API key is a credential, and this page is open in
                // front of other people often enough.
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="lin_api_…"
                onChange={(e) => setKey(e.currentTarget.value)}
              />
              {/* Height matched to the field beside it rather than left at the
                  small default — two controls on one line that disagree about
                  how tall they are read as a mistake before they read as a
                  form. */}
              <Button type="submit" className="h-9 shrink-0" disabled={busy || !key.trim()}>
                {busy ? "Connecting…" : "Connect"}
              </Button>
            </form>

            {error && <p className="text-ui text-destructive">{error}</p>}

            <button
              type="button"
              className="self-start text-ui text-muted-foreground hover:text-foreground"
              onClick={() => void openUrl(LINEAR_KEYS_URL)}
            >
              Create a key in Linear
            </button>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <p className="flex items-center gap-2 text-ui font-medium">
                <GitHubIcon className="size-3.5" />
                Sign in to GitHub
              </p>
              {/* No form, and saying why is the whole of this sentence: the
                  reader is looking at a pane that asks nothing of them, and a
                  screen with no field on it should say what is filling in for
                  one rather than leave them hunting for it. */}
              <p className="text-ui text-muted-foreground">
                Dray reads GitHub issues through the <code>gh</code> CLI and holds no credential of
                its own, so there is nothing to paste here.
              </p>
            </div>

            {/* The command, then the install under it — **that order**, because
                a logged-out `gh` is far commoner than an absent one and the
                pane should open on the likelier cure. The install line is not
                optional: without it the only instruction on screen is a command
                that does not exist on a machine that never had the CLI. */}
            <p className="text-ui text-muted-foreground">
              Run{" "}
              <button
                type="button"
                className="text-foreground underline underline-offset-2 hover:text-foreground/80"
                onClick={() => void openUrl(GH_AUTH_URL)}
              >
                <code>{LOGIN_COMMAND}</code>
              </button>{" "}
              in a terminal, then check again.
            </p>

            <p className="text-ui text-muted-foreground">
              No <code>gh</code> yet? <code className="text-foreground">{INSTALL_COMMAND}</code>
            </p>

            {/* **The only way off this pane short of relaunching the app**, and
                the sentence above names it rather than saying "refresh", which
                promised a control that was not here. Two process-lifetime caches
                stand between a successful `gh auth login` and this screen and
                the button throws both away — see `recheckGithub`.

                It claims nothing about what it found: a missing `gh` and a
                logged-out one are one state here, so the pane simply stays where
                the answer has not moved. */}
            <Button
              variant="outline"
              className="h-9 self-start"
              disabled={busy}
              onClick={() => void onRecheckGithub()}
            >
              {busy ? "Checking…" : "Check again"}
            </Button>
          </>
        )}

        {/* The other tracker, and only while it is missing too. Said here
            because this is the surface with nothing to show, and somebody one
            command away from a page full of issues should not have to find that
            out from a switch they have not pressed. Quieter than whatever is
            above it: only one of the two is being asked for. */}
        {tracker === "linear" && !connected.github && (
          <p className="flex items-start gap-2 border-t border-border pt-3 text-ui text-muted-foreground">
            <GitHubIcon className="mt-0.5 size-3.5" />
            <span>
              Or sign in to GitHub with{" "}
              <button
                type="button"
                className="text-foreground underline underline-offset-2 hover:text-foreground/80"
                onClick={() => void openUrl(GH_AUTH_URL)}
              >
                <code>{LOGIN_COMMAND}</code>
              </button>{" "}
              — Dray reads GitHub issues through the <code>gh</code> CLI, so there is no key to
              paste.
            </span>
          </p>
        )}

        {tracker === "github" && !connected.linear && (
          <p className="flex items-start gap-2 border-t border-border pt-3 text-ui text-muted-foreground">
            <LinearIcon className="mt-0.5 size-3.5" />
            <span>Or connect Linear with a personal API key — the switch above.</span>
          </p>
        )}

        {/* The other half of the setup, and this is the place to say it. This
            key is what fills *these* screens; it gives the agent nothing. An
            agent that is to read an issue in full, or move one, needs Linear's
            MCP server — and someone finding that out later, from a model
            working off a one-line title, finds it out the expensive way. Said
            here, while they are already setting this up, and said once.

            Linear's alone: GitHub's half of it is the `gh` CLI the agent
            already has, and there is nothing to add. */}
        {tracker === "linear" && (
          <p className="border-t border-border pt-3 text-ui text-muted-foreground">
            Dray reads your issues with this key, and writes only the status or priority you pick.
            To let the agent read and manage issues in chat, add{" "}
            <button
              type="button"
              className="text-foreground underline underline-offset-2 hover:text-foreground/80"
              onClick={() => void openUrl(LINEAR_MCP_URL)}
            >
              Linear's MCP server
            </button>{" "}
            to your CLI.
          </p>
        )}
      </div>
    </div>
  );
}

/// One status bucket, collapsible, with the kind's own glyph beside the name.
///
/// Grouped because a flat list of forty issues has no shape: what is in
/// progress and what is still a wish are different questions, and the tracker
/// the reader already has open groups them exactly this way.
///
/// No fill behind the header, and space between groups instead. A tinted band
/// across the page draws a box round the quietest line on it; a gap says the
/// same thing with nothing at all, and leaves the rows as the only marked
/// surface. The glyph is what the row above gave up — one copy, on the heading
/// that names the state, rather than one per row repeating it.
function Group({
  kind,
  label,
  count,
  collapsedByDefault = false,
  onFirstOpen,
  children,
}: {
  kind: IssueStateKind;
  label: string;
  /// `null` for a group whose rows have not been read yet — the settled ones
  /// before anybody opens them. A zero there would be a claim, not a blank.
  count: number | null;
  collapsedByDefault?: boolean;
  onFirstOpen?: () => void;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(collapsedByDefault);

  return (
    <div className="mb-1.5 last:mb-0">
      <button
        type="button"
        onClick={() => {
          if (collapsed) onFirstOpen?.();
          setCollapsed((prev) => !prev);
        }}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-ui text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
        <IssueStateIcon kind={kind} />
        <span className="font-medium text-foreground">{label}</span>
        {count !== null && <span className="tabular-nums">{count}</span>}
      </button>

      {!collapsed && children}
    </div>
  );
}

/// Which repository the GitHub half is reading, on its face.
///
/// Wears the name rather than a glyph, because it is the one control here whose
/// *value* is the answer to "what am I looking at" — the scope chips beside it
/// say what they are by being lit, and this one has a hundred possible states.
/// The rows are the repositories of attached projects with a `github.com`
/// remote, which is the list this app can name without a network call.
///
/// **The repository, not the whole slug.** `monorepo-labs/dray` is most of this
/// row's width spent on a word that is the same for most of the list, and the
/// owner is only ever needed to tell two same-named repositories apart — which
/// is a question asked where the pick is made. So the menu rows carry the slug
/// whole and the trigger carries the name. No tooltip restoring it: a menu is
/// one click away and already answers, where a tooltip on something that opens
/// on hover-and-click is a second thing arriving over the first.
function RepoMenu({
  repo,
  repos,
  onPick,
}: {
  repo: string | null;
  repos: IssueGroup[];
  onPick: (repo: string) => void;
}) {
  // Nothing to choose between, and the empty state below already says what to
  // do about that — a trigger reading "Choose a repository" that opens onto
  // nothing is a control that cannot be used.
  if (!repos.length) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-ui transition-colors",
            repo
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <GitHubIcon className="size-3.5" />
          <span className="max-w-40 truncate">
            {repo ? repo.slice(repo.indexOf("/") + 1) : "Choose a repository"}
          </span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Repository</DropdownMenuLabel>
        {repos.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.id}
            checked={repo === option.id}
            // No "all repositories" to clear to: a number is only addressable
            // within one, so picking is the only move — which is why this is a
            // radio group spelled with checkmarks and the current row stays
            // pickable rather than going grey.
            onCheckedChange={() => onPick(option.id)}
          >
            {option.name}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// Which label the GitHub half is narrowed to, on its face.
///
/// Wears its value like `RepoMenu` above rather than folding into the sliders
/// menu, and for the same reason: a narrowing set on a previous visit is what
/// an empty-looking list is usually explained by, and a lit glyph says a filter
/// is on without saying which. The labels are the repository's own, so this
/// draws nothing at all where that read has not landed or the repository has
/// none — a trigger opening onto one row that clears nothing is no control.
function LabelMenu({
  label,
  labels,
  onPick,
}: {
  label: string | null;
  labels: IssueLabel[];
  onPick: (label: string | null) => void;
}) {
  if (!labels.length) return null;

  const picked = labels.find((option) => option.name === label);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-ui transition-colors",
            label
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {picked ? <IssueLabelChip label={picked} dot /> : <Tag className="size-3.5" />}
          <span className="max-w-40 truncate">{label ?? "Label"}</span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="max-h-96 w-56 overflow-y-auto">
        <DropdownMenuLabel>Label</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={!label} onCheckedChange={() => onPick(null)}>
          All labels
        </DropdownMenuCheckboxItem>
        {labels.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.name}
            checked={label === option.name}
            // One axis, one value: picking another replaces this, and the row
            // already on is what clears it — the shape every menu here takes.
            onCheckedChange={(on) => onPick(on ? option.name : null)}
          >
            <span className="flex items-center gap-1.5">
              <IssueLabelChip label={option} dot />
              {option.name}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// The filters, behind one control.
///
/// A menu rather than more chips: these narrow *within* whichever chip is on,
/// and four more controls across the header would be four things to read past
/// on every visit to change none of them.
///
/// A team or project list with one entry is not offered at all — a filter whose
/// only option is "the one you already have" is a control that cannot do
/// anything, and this is a solo tool often pointed at a single team.
function FilterMenu({
  query,
  filters,
  tracker,
  onChange,
}: {
  query: IssueQuery;
  filters: { teams: IssueGroup[]; projects: IssueGroup[] } | null;
  tracker: IssueTracker;
  onChange: (patch: Partial<IssueQuery>) => void;
}) {
  const github = tracker === "github";

  // **Nothing at all under GitHub**, and both halves are deliberate: the
  // repository has its own control on the row beside this one, since it is the
  // list rather than a narrowing of one, and GitHub Projects are a board an
  // issue is placed on rather than a field it carries — a different query
  // against a different object. So the trigger does not draw there.
  const teams = !github && filters && filters.teams.length > 1 ? filters.teams : [];
  const projects = !github && filters && filters.projects.length > 1 ? filters.projects : [];
  const narrowed = !!query.teamId || !!query.projectId;

  // Nothing left to narrow by. A trigger that opens an empty menu is worse than
  // no trigger, and a single-team workspace is the ordinary case here — as is
  // GitHub, whose two controls both stand on the row.
  if (!teams.length && !projects.length) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Filters"
          // Lit while something is on, so a list narrowed by a filter set on a
          // previous visit says so rather than reading as an empty workspace.
          className={cn(
            narrowed ? "text-foreground" : "text-muted-foreground/60 hover:text-muted-foreground",
          )}
        >
          <SlidersHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        {teams.length > 0 && (
          <>
            <DropdownMenuLabel>Team</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={!query.teamId}
              onCheckedChange={() => onChange({ teamId: null })}
            >
              All teams
            </DropdownMenuCheckboxItem>
            {teams.map((team) => (
              <DropdownMenuCheckboxItem
                key={team.id}
                checked={query.teamId === team.id}
                // Picking one clears the other, so the menu is a radio group
                // spelled with checkmarks — the shape the rest of the app's
                // menus use, and one filter per axis is what the backend takes.
                onCheckedChange={(on) => onChange({ teamId: on ? team.id : null })}
              >
                {team.name}
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}

        {projects.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Project</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={!query.projectId}
              onCheckedChange={() => onChange({ projectId: null })}
            >
              All projects
            </DropdownMenuCheckboxItem>
            {projects.map((project) => (
              <DropdownMenuCheckboxItem
                key={project.id}
                checked={query.projectId === project.id}
                onCheckedChange={(on) => onChange({ projectId: on ? project.id : null })}
              >
                {project.name}
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// One issue. The whole row opens it in the pane beside this one.
///
/// It used to open the tracker in a browser, and that was a trip taken for
/// something the app already had: the pane draws the description, the people,
/// the attachments and the conversation from the same key this list was read
/// with. Linear is still one click away — the pane's own row carries the
/// button — but it is the second thing offered rather than the first.
///
/// "Work on it" starts nothing. It cannot: this page is workspace-wide, so a
/// button that spawned a session would have to guess which repo the work belongs
/// in. It hands the reader to the empty composer with the issue already tagged
/// instead — which is the one place that *does* know how to ask, since the
/// project, the model and the harness are all still sitting there unpicked.
function IssueRow({
  issue,
  picked,
  scopedToMe,
  states,
  onPick,
  onWorkOn,
}: {
  issue: Issue;
  picked: boolean;
  /// Whether the list this row is in was narrowed to the reader's own issues,
  /// which is what makes the assignee's face a second copy of the chip above.
  scopedToMe: boolean;
  /// The statuses this issue's team offers. Empty until the filters read lands,
  /// which leaves the glyph a plain one.
  states: IssueState[];
  onPick: (issue: Issue) => void;
  onWorkOn: (issue: Issue) => void;
}) {
  const workOn = (e: SyntheticEvent) => {
    e.stopPropagation();
    onWorkOn(issue);
  };

  return (
    // A div behaving as a button, the shape `IssuePanel`'s own row uses. This
    // was a real `button` back when the only thing inside it was one span
    // pretending to be one; it now carries two menu triggers as well, and three
    // focusable controls nested in a `button` is invalid markup whose keyboard
    // behaviour assistive tech is free to collapse into the row's own action.
    <div
      role="button"
      tabIndex={0}
      // ⌘-click leaves for the tracker, the same modifier the transcript's link
      // dialog uses to mean "out there, not here". An ordinary click still opens
      // the pane, which is what this row is for — Linear is the shortcut.
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) {
          void openUrl(issue.url);
          return;
        }
        onPick(issue);
      }}
      // A control inside the row answers its own keys, or Enter on a status menu
      // opens it and picks the row underneath in one press.
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onPick(issue);
      }}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-ui transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        picked ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50",
      )}
    >
      {/* Always drawn, "no priority" included. A glyph that appears on only
          some rows shifts every title beside it, and a ragged left edge reads
          as disorder rather than as information.

          **Absent entirely on GitHub, where there is no priority field at
          all.** Not a glyph reading "none" on every row — that says the issues
          are unprioritized, where the truth is that the tracker has no such
          question — and not a menu, which could only refuse every pick. The
          rows are all the same width without it, so nothing goes ragged. */}
      {issue.tracker === "linear" && <PriorityMenu issue={issue} priority={issue.priority} />}

      {/* Every row here is in the one repository the page is reading, so a
          GitHub identifier would spend this column saying the slug over and
          over. The number is what tells the rows apart — and the column is
          narrower for it, or the width a `DRA-123` needs sits as a gap beside
          every `#108` on a page that has already dropped the priority glyph. */}
      <span
        className={cn(
          "shrink-0 truncate text-muted-foreground tabular-nums",
          issue.tracker === "github" ? "w-10" : "w-16",
        )}
      >
        {shortIdentifier(issue.identifier)}
      </span>

      {/* The status glyph repeats the heading the row is already gathered
          under, and it earns that repetition by being a *control*: moving an
          issue to In Progress is the commonest thing anybody does on this page,
          and sending them into the pane to do it made the list a place you only
          read from. Same order as the panel's own header — priority, then the
          identifier, then status — so the two surfaces read as one.

          **Absent under GitHub**, where that bargain stops paying. Linear's six
          states make the glyph a reading as well as a control — which of the
          six this row is on — where GitHub has two and the switch above has
          already picked one, so every glyph in the list says the same word the
          control at the top of it does. Closing an issue moves to the Details
          pane, which carries the same menu. */}
      {issue.tracker !== "github" && (
        <StatusMenu issue={issue} state={issue.state} states={states} />
      )}

      <span className="min-w-0 flex-1 truncate">{issue.title}</span>

      {/* A span carrying `buttonVariants` rather than a `Button`. The row is a
          div with `role="button"` and this stays a span with it: the row's
          accessible role is what a nested control conflicts with, not the tag
          it happens to use, so promoting either to a real `button` would put
          the invalid nesting straight back. Same bargain `FileLink` makes, and
          `stopPropagation` on the key as well as the click is what keeps the
          two apart — the row's own `target === currentTarget` guard is the
          other half.

          Its slot is reserved whether or not it is drawn: revealed by adding
          width, the whole row would shift under the cursor that revealed it.
          Hidden by opacity rather than `display`, or it could not be reached by
          keyboard at all. */}
      <span
        role="button"
        tabIndex={0}
        onClick={workOn}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          workOn(e);
        }}
        className={cn(
          buttonVariants({ variant: "ghost", size: "xs" }),
          "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
        )}
      >
        Work on it
        <Plus data-icon="inline-end" />
      </span>

      {/* Who filed it, GitHub's rows alone. It is the person field that always
          has an answer there — an issue is assigned to nobody far more often
          than not — and the row has the width for it, having given up the
          priority slot and the status glyph. A Linear row has both of those and
          an assignee besides, so a fourth thing about people would be the
          crowded end of a row that is already saying enough. */}
      {issue.tracker === "github" && issue.author && (
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <Avatar src={issue.author.avatar} name={issue.author.name} className="size-3.5" />
          <span className="max-w-24 truncate">{issue.author.name}</span>
        </span>
      )}

      {/* The first few labels, in their own colours. A label is most of what
          a GitHub issue says about itself before you open it — bug, docs,
          good first issue — and the panel beside this one already draws them,
          so a list that does not is the list asking to be clicked through.
          Capped, and dropped on a narrow pane: past three they stop being
          information and start being a second title. */}
      {issue.labels.slice(0, 3).map((label) => (
        <IssueLabelChip key={label.name} label={label} className="hidden lg:inline" />
      ))}

      {issue.project && (
        <span className="hidden shrink-0 rounded-full border border-border px-1.5 py-px text-muted-foreground lg:inline">
          {issue.project}
        </span>
      )}

      {/* Work already under way, both trackers. It is the one thing on the row
          that is not about the issue at all but about somebody having started
          on it, which is what the reader scanning a list is looking for — and
          on Linear it is the only signal there, the status glyph saying In
          Progress whether a PR exists or not.

          Inert, like the labels and the project chip beside it: a single number
          could open that PR and a count could not, and a chip that is a link on
          some rows and text on others is worse than one that is never a link.
          ⌘-click on the row still leaves for the tracker, where they are
          listed. */}
      {issue.pullRequests.length > 0 && (
        <span className="hidden shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-muted-foreground sm:inline-flex">
          <GitPullRequest className="size-3" />
          {issue.pullRequests.length === 1
            ? `#${issue.pullRequests[0]}`
            : `${issue.pullRequests.length} PRs`}
        </span>
      )}

      {/* Who has it. Unassigned draws nothing rather than a placeholder head:
          the question is "whose is this", and a row with no answer should read
          as quiet, not as somebody with no face.

          **And nothing at all under "Assigned to me"**, where the answer is the
          reader on every row — their own face down the edge of a list they
          asked for by name says only what the lit chip above it already does.
          The creator beside it is a different person and stays. */}
      {!scopedToMe && issue.assignee && (
        <Avatar
          src={issue.assignee.avatar}
          name={issue.assignee.name}
          className="hidden sm:flex"
        />
      )}

      {/* **When it was filed, not when it last moved.** "Updated" is a fact
          about the conversation rather than about the work, and on a tracker
          anything automated touches it says more about the bots than about the
          issue. The opened issue's own header still reports the last move,
          which is where that question is actually asked.

          The least of what the row says and the first thing to go when it is
          narrow — the identifier and the title are what it is read for. */}
      <span className="hidden w-16 shrink-0 text-right text-muted-foreground sm:inline">
        {calendarDay(issue.createdAt)}
      </span>
    </div>
  );
}
