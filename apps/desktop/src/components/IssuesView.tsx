import { useEffect, useMemo, useState, type MutableRefObject, type SyntheticEvent } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronRight, Plus, RefreshCw, Search, SlidersHorizontal } from "lucide-react";

import Avatar from "@/components/Avatar";
import { PriorityMenu, StatusMenu } from "@/components/IssueMenus";
import IssueStateIcon from "@/components/IssueStateIcon";
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
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IS_MAC } from "@/lib/platform";
import { useHotkey } from "@/hooks/useHotkey";
import { useIssues } from "@/hooks/useIssues";
import { groupIssues } from "@/lib/issue";
import { calendarDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  Issue,
  IssueGroup,
  IssueQuery,
  IssueScope,
  IssueState,
  IssueStateKind,
  IssueUnavailable,
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

/// What a failed read says, in one line.
///
/// The cure is named where there is one — a key Linear has stopped accepting is
/// fixed by disconnecting in Settings and pasting a new one here, and saying so
/// is the difference between a sentence to act on and one to stare at. Anything
/// unrecognised falls back to the tracker's own words rather than a shrug of
/// our own.
function unavailableText(unavailable: IssueUnavailable): string {
  switch (unavailable.kind) {
    case "unauthorized":
      return "Linear rejected the saved key. Disconnect it in Settings, then paste a new one.";
    case "offline":
      return "Could not reach Linear.";
    case "not_connected":
      return "No issue tracker connected.";
    default:
      return unavailable.detail;
  }
}

const SCOPES: { value: IssueScope; label: string }[] = [
  { value: "assigned", label: "Assigned to me" },
  { value: "created", label: "Created" },
];

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
  picked,
  onPick,
  onWorkOn,
  refreshRef,
}: {
  /// The page is the thing on screen. Hidden pages do not read, for the reason
  /// the right panel's own `active` exists.
  active: boolean;
  connected: boolean;
  /// Answers whether the key was accepted, so the field can clear itself only
  /// on success.
  onConnect: (key: string) => Promise<boolean>;
  connecting: boolean;
  connectError: string | null;
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
  const { issues, settled, filters, query, setQuery, loading, loaded, unavailable, refresh } =
    useIssues(active && connected);

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
    "f",
    () => document.querySelector<HTMLInputElement>(`#${ISSUE_SEARCH_INPUT_ID}`)?.select(),
    { shift: true, enabled: active && connected },
  );

  /// The workflow a row's status menu offers, which belongs to the issue's own
  /// team. Read once per connection with the filter options rather than per
  /// issue — a team's states are the same answer for every row it owns, so
  /// asking for them on the list read would repeat one workflow a hundred times
  /// down the wire. Empty until that read lands, which draws a plain glyph.
  const statesFor = (issue: Issue) =>
    (issue.team && filters?.teamStates[issue.team]) || [];
  const groups = useMemo(() => groupIssues(issues), [issues]);
  const settledGroups = useMemo(() => groupIssues(settled.issues), [settled.issues]);

  if (!connected) {
    return <Connect onConnect={onConnect} busy={connecting} error={connectError} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-3 pt-3">
        {SCOPES.map((scope) => (
          // Chips rather than a menu, because these are the two questions worth
          // one press: what is mine to do, and what did I ask for. Everything
          // that narrows *within* an answer is behind the control beside them.
          <button
            key={scope.value}
            type="button"
            onClick={() => set({ scope: scope.value })}
            className={cn(
              "rounded-full px-2.5 py-1 text-ui transition-colors",
              query.scope === scope.value
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {scope.label}
          </button>
        ))}

        <FilterMenu query={query} filters={filters} onChange={set} />

        {/* Far right, away from the chips. It acts on the whole page rather
            than narrowing it, so sitting in the row of things that narrow read
            as a third chip. Same corner and same chord as the right panel's,
            which is the point: the chord means "re-read what I am looking at",
            and never a specific thing. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh"
              className="ml-auto text-muted-foreground/60 hover:text-muted-foreground"
              onClick={refresh}
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            Refresh
            <KbdGroup>
              <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
              <Kbd>R</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
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
        <KbdGroup className="group-focus-within:hidden">
          <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
          {/* Spelled out, not ⇧. Beside a single glyph the arrow reads as part
              of the key next to it; the word cannot be mistaken for one. */}
          <Kbd>Shift</Kbd>
          <Kbd>F</Kbd>
        </KbdGroup>
      </div>

      {/* Under the header rather than over the rows: a failed refresh leaves
          what was already read on screen, and this says the answer is stale. */}
      {unavailable && (
        <p className="border-b border-border px-3 py-2 text-ui text-destructive">
          {unavailableText(unavailable)}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Nothing else while the first read is out — not even the settled
            headings, which are the one part of this list that can be drawn
            without an answer and so were the only thing on screen. A page whose
            finished work appears first, and whose open work arrives second,
            reads as a workspace with nothing left to do. */}
        {!loaded && <p className="px-3 py-2 text-ui text-muted-foreground">Reading…</p>}

        {loaded && issues.length === 0 && !loading && (
          <p className="px-3 py-4 text-ui text-muted-foreground">
            {query.text
              ? "No issue matches that."
              : query.scope === "created"
                ? "Nothing you filed is open."
                : "Nothing assigned to you."}
          </p>
        )}

        {loaded &&
          groups.map((group) => (
            <Group key={group.key} kind={group.key} label={group.label} count={group.issues.length}>
              {group.issues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  picked={issue.identifier === picked}
                  states={statesFor(issue)}
                  onPick={onPick}
                  onWorkOn={onWorkOn}
                />
              ))}
            </Group>
          ))}

        {/* Done and Cancelled are always here and always start closed. Finished
            work is most of a workspace and almost never what the page was
            opened for — but it is what the reader wants when they want it, and
            a filter they have to find first is worse than a heading they can
            see. Nothing is fetched until one is opened: the headings cost a
            round trip only when somebody asks a question of them. */}
        {loaded &&
          SETTLED_KINDS.map(({ key, label }) => {
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
      </div>
    </div>
  );
}

/// The page with nothing connected, and the key field is *here* rather than a
/// trip to settings — this is the surface that has nothing to show without one,
/// so this is where the thing that fixes it belongs.
function Connect({
  onConnect,
  busy,
  error,
}: {
  onConnect: (key: string) => Promise<boolean>;
  busy: boolean;
  error: string | null;
}) {
  const [key, setKey] = useState("");

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
      <div className="flex w-full max-w-sm flex-col gap-3">
        <div className="flex flex-col gap-1">
          {/* The mark, because it is what makes this recognisable before the
              sentence under it is read — and this is one of the two places in
              the app where naming the tracker is the point rather than a leak
              of the implementation. */}
          <p className="flex items-center gap-2 text-ui font-medium">
            <LinearIcon />
            Connect Linear
          </p>
          {/* The smaller ask is still offered, and second: read alone is what
              somebody wary of pasting a credential into a desktop app can give,
              and naming it is what keeps that a small decision. Write is named
              first because it is what the app now does, and leaving it out
              would have the reader find out from a status menu that fails. */}
          <p className="text-ui text-muted-foreground">
            Paste a personal API key with read and write access. A read-only key works too — you
            just cannot change a status or priority.
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
              small default — two controls on one line that disagree about how
              tall they are read as a mistake before they read as a form. */}
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

        {/* The other half of the setup, and this is the place to say it.
            This key is what fills *these* screens; it gives the agent nothing.
            An agent that is to read an issue in full, or move one, needs
            Linear's MCP server — and someone finding that out later, from a
            model working off a one-line title, finds it out the expensive way.
            Said here, while they are already setting this up, and said once. */}
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
  onChange,
}: {
  query: IssueQuery;
  filters: { teams: IssueGroup[]; projects: IssueGroup[] } | null;
  onChange: (patch: Partial<IssueQuery>) => void;
}) {
  const teams = filters && filters.teams.length > 1 ? filters.teams : [];
  const projects = filters && filters.projects.length > 1 ? filters.projects : [];
  const narrowed = !!query.teamId || !!query.projectId;

  // Nothing left to narrow by. A trigger that opens an empty menu is worse than
  // no trigger, and a single-team workspace is the ordinary case here.
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
  states,
  onPick,
  onWorkOn,
}: {
  issue: Issue;
  picked: boolean;
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
    <button
      type="button"
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
      className={cn(
        "group flex w-full items-center gap-2 px-3 py-2 text-left text-ui transition-colors",
        picked ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50",
      )}
    >
      {/* Always drawn, "no priority" included. A glyph that appears on only
          some rows shifts every title beside it, and a ragged left edge reads
          as disorder rather than as information. */}
      <PriorityMenu issue={issue} priority={issue.priority} />

      <span className="w-16 shrink-0 truncate text-muted-foreground tabular-nums">
        {issue.identifier}
      </span>

      {/* The status glyph repeats the heading the row is already gathered
          under, and it earns that repetition by being a *control*: moving an
          issue to In Progress is the commonest thing anybody does on this page,
          and sending them into the pane to do it made the list a place you only
          read from. Same order as the panel's own header — priority, then the
          identifier, then status — so the two surfaces read as one. */}
      <StatusMenu issue={issue} state={issue.state} states={states} />

      <span className="min-w-0 flex-1 truncate">{issue.title}</span>

      {issue.project && (
        <span className="hidden shrink-0 rounded-full border border-border px-1.5 py-px text-muted-foreground lg:inline">
          {issue.project}
        </span>
      )}

      {/* A span carrying `buttonVariants` rather than a `Button`, because the
          row itself is a button and a nested one is invalid markup — the click
          would open the pane instead. Same bargain `FileLink` makes, and
          `stopPropagation` on the key as well as the click is what keeps them
          apart.

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

      {/* Who has it. Unassigned draws nothing rather than a placeholder head:
          the question is "whose is this", and a row with no answer should read
          as quiet, not as somebody with no face. */}
      {issue.assignee && (
        <Avatar
          src={issue.assignee.avatar}
          name={issue.assignee.name}
          className="hidden sm:flex"
        />
      )}

      {/* The least of what the row says and the first thing to go when it is
          narrow — the identifier and the title are what it is read for. */}
      <span className="hidden w-16 shrink-0 text-right text-muted-foreground sm:inline">
        {calendarDay(issue.updatedAt)}
      </span>
    </button>
  );
}
