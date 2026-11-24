import { useMemo, useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, MessageSquare, RefreshCw } from "lucide-react";

import Avatar from "@/components/Avatar";
import PageSearch from "@/components/PageSearch";
import TaskChip from "@/components/TaskChip";
import { ListGroup, RepoMenu } from "@/components/ListGroup";
import { MissingCli } from "@/components/PrPanel";
import PrStateIcon, { ChecksRunningIcon } from "@/components/PrStateIcon";
import ShortcutKeys from "@/components/ShortcutKeys";
import Counts from "@/components/changes/Counts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebouncedSearch } from "@/hooks/useDebouncedSearch";
import { useHotkey } from "@/hooks/useHotkey";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { relativeTime } from "@/lib/format";
import {
  SECTIONS,
  inboxSection,
  matchesPullSearch,
  rowRepoName,
  type InboxRow,
  type PeopleFilter,
} from "@/lib/prInbox";
import { cn } from "@/lib/utils";
import type { Bot, PrUnavailable, SessionIndexItem } from "@/types/events";

/// Which workspace's projects the page lists: the active space's, or every one.
export type PullsScope = "space" | "all";

const PEOPLE: readonly { value: PeopleFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "involving", label: "Involving me" },
  { value: "mine", label: "Mine" },
  { value: "review", label: "Review requested" },
];

/// How the empty list names the people filter it ran under.
const PEOPLE_EMPTY: Record<PeopleFilter, string> = {
  all: "",
  involving: " involving you",
  mine: " of yours",
  review: " awaiting your review",
};

const SCOPES: readonly { value: PullsScope; label: string }[] = [
  { value: "space", label: "This space" },
  { value: "all", label: "All spaces" },
];

/// Which spaces' repos the page lists, beside the owner and repo menus that
/// narrow it further. Always holds a pick, so the trigger names it.
function ScopeMenu({ scope, onScope }: { scope: PullsScope; onScope: (scope: PullsScope) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-ui text-muted-foreground transition-colors hover:text-foreground"
        >
          {SCOPES.find((option) => option.value === scope)?.label}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel>Spaces</DropdownMenuLabel>
        {SCOPES.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={scope === option.value}
            onCheckedChange={() => onScope(option.value)}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// Every open pull request in the projects on screen, filed by what it wants
/// from the reader. The page lists and picks; the pane beside it, owned by
/// `App`, draws the picked one and sends its messages.
///
/// Reads nothing itself: the rows come off the sidebar's own PR marks, read for
/// these repos while the page is open, so there is no third cache to keep in
/// step with the marks and the PR tab.
export default function PullsView({
  rows,
  loaded,
  hasRepos,
  missing,
  errors,
  offline,
  active,
  people,
  onPeople,
  scope,
  onScope,
  owners,
  owner,
  onOwner,
  sessionsFor,
  botOf,
  onOpenSession,
  picked,
  onPick,
  loading,
  onRefresh,
}: {
  rows: InboxRow[];
  /// At least one repo has answered, or failed to. Until then there is nothing
  /// to say about an empty list.
  loaded: boolean;
  /// Whether any project is in scope at all.
  hasRepos: boolean;
  /// `gh` missing or logged out, which no row can be drawn without, and the
  /// repo to ask about it from.
  missing: { kind: "no_cli" | "not_authenticated"; cwd: string } | null;
  /// Repos whose last read failed for a reason worth saying.
  errors: { name: string; error: PrUnavailable }[];
  /// Machines that are down holding a project whose repo can't be named, so
  /// its pull requests can't be listed until they are back.
  offline: string[];
  /// Whether the page is on screen, which is when ⌘E is its own.
  active: boolean;
  people: PeopleFilter;
  onPeople: (people: PeopleFilter) => void;
  scope: PullsScope;
  onScope: (scope: PullsScope) => void;
  /// Who "Involving me" can be narrowed to: the reader, then their orgs.
  owners: string[];
  owner: string | null;
  onOwner: (owner: string | null) => void;
  sessionsFor: (row: InboxRow) => SessionIndexItem[];
  /// The bot a session is a task of, to name it on the row.
  botOf: (item: SessionIndexItem) => Bot | undefined;
  onOpenSession: (item: SessionIndexItem) => void;
  picked: InboxRow | null;
  /// `null` closes the pane.
  onPick: (row: InboxRow | null) => void;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [repo, setRepo] = useLocalStorage<string | null>("ade.pullsRepo", null);

  const repos = useMemo(() => [...new Set(rows.map(rowRepoName))].sort(), [rows]);
  // A repo picked under another scope may have no rows here; the filter then
  // reads as off rather than hiding the whole list behind a name not listed.
  const repoShown = repo && repos.includes(repo) ? repo : null;
  // Owners on offer: those the search has met, and those of the rows here.
  const ownerList = [...new Set([...owners, ...rows.map((row) => rowRepoName(row).split("/")[0])])];
  const [search, setSearch] = useState("");
  const query = useDebouncedSearch(search.trim());
  const shown = rows.filter(
    (row) =>
      (!owner || rowRepoName(row).split("/")[0].toLowerCase() === owner.toLowerCase()) &&
      (!repoShown || rowRepoName(row) === repoShown) &&
      matchesPullSearch(row, query),
  );
  const sections = SECTIONS.map((section) => ({
    ...section,
    rows: shown.filter((row) => inboxSection(row.mark) === section.key),
  })).filter((section) => section.rows.length > 0);

  // ⌘E opens and shuts the pane here, the issues page's rule: `App` gives the
  // chord up on every page, and only the list knows which row to put back —
  // the one last open, else the first on screen.
  const [cursor, setCursor] = useState<InboxRow | null>(picked);
  if (picked && picked !== cursor) setCursor(picked);
  useHotkey(
    "panel.toggle",
    () => {
      const first = sections[0]?.rows[0] ?? null;
      onPick(picked ? null : (cursor && shown.some((row) => row.mark.url === cursor.mark.url) ? cursor : first));
    },
    { enabled: active && !missing },
  );

  if (missing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <MissingCli
          kind={missing.kind}
          cwd={missing.cwd}
          loading={loading}
          refresh={onRefresh}
          lead="Pull requests come from the GitHub CLI."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The issues page's header: what the page is on the left, what narrows
          it on the right, wrapping rather than squeezing. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pt-3">
        {PEOPLE.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onPeople(option.value)}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-ui transition-colors",
              people === option.value
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}

        <div className="flex-1" aria-hidden />

        <div className="flex shrink-0 items-center gap-1.5">
          <ScopeMenu scope={scope} onScope={onScope} />
          {ownerList.length > 0 && (
            <RepoMenu
              repo={owner}
              repos={(owner && !ownerList.includes(owner) ? [owner, ...ownerList] : ownerList).map((name) => ({ id: name, name }))}
              onPick={onOwner}
              placeholder="All owners"
              anyLabel="All owners"
              heading="Owner"
            />
          )}
          {repos.length > 0 && (
            <RepoMenu
              repo={repoShown}
              repos={repos.map((name) => ({ id: name, name }))}
              onPick={setRepo}
              placeholder="All repositories"
              anyLabel="All repositories"
            />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh"
                className="text-muted-foreground/60 hover:text-muted-foreground"
                onClick={onRefresh}
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

      <PageSearch
        id="pulls-search"
        active={active}
        value={search}
        onChange={setSearch}
        placeholder="Search pull requests"
      />

      {offline.length > 0 && (
        <p className="px-3 pb-2 text-ui text-muted-foreground">
          {offline.join(", ")} {offline.length === 1 ? "is" : "are"} offline, so some pull requests may be missing.
        </p>
      )}

      {errors.map(({ name, error }) => (
        <p key={name} className="border-b border-border px-3 py-2 text-ui text-destructive">
          {name}: {error.kind === "other" ? error.detail : "could not be read."}
        </p>
      ))}

      <div className="@container min-h-0 flex-1 overflow-y-auto pb-2">
        {!hasRepos ? (
          <p className="px-3 py-4 text-ui text-muted-foreground">
            Attach a project with a GitHub remote to see its pull requests.
          </p>
        ) : !loaded ? (
          <p className="px-3 py-2 text-ui text-muted-foreground">Reading…</p>
        ) : sections.length === 0 ? (
          <p className="px-3 py-4 text-ui text-muted-foreground">
            {query && rows.length > 0
              ? `No pull request matches “${query}”.`
              : rows.length > 0
              ? "No pull request matches these filters."
              : `No open pull requests${PEOPLE_EMPTY[people]}${scope === "space" ? " in this space" : ""}.`}
          </p>
        ) : (
          sections.map((section) => (
            <ListGroup key={section.key} label={section.label} count={section.rows.length}>
              {section.rows.map((row) => (
                <PullRow
                  key={row.mark.url}
                  row={row}
                  sessions={sessionsFor(row)}
                  botOf={botOf}
                  onOpenSession={onOpenSession}
                  showRepo={!repoShown && repos.length > 1}
                  picked={picked?.mark.url === row.mark.url}
                  onPick={() => onPick(picked?.mark.url === row.mark.url ? null : row)}
                />
              ))}
            </ListGroup>
          ))
        )}
      </div>
    </div>
  );
}

/// One pull request. ⌘-click opens it on GitHub, the issues page's rule; a
/// plain click opens the pane beside the list.
function PullRow({
  row,
  sessions,
  botOf,
  onOpenSession,
  showRepo,
  picked,
  onPick,
}: {
  row: InboxRow;
  /// Its tasks, live or settled, newest first — a chip on the row so a PR
  /// nobody has worked on stands out, and opened from there.
  sessions: SessionIndexItem[];
  botOf: (item: SessionIndexItem) => Bot | undefined;
  onOpenSession: (item: SessionIndexItem) => void;
  showRepo: boolean;
  picked: boolean;
  onPick: () => void;
}) {
  const { mark, listing } = row;

  // Reads nothing on hover or focus: the pane's read is 2 points of a budget
  // every agent shares, so it waits for the click.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return void openUrl(mark.url);
        onPick();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onPick();
      }}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-ui transition-colors focus-visible:outline-none",
        picked ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
      )}
    >
      <PrStateIcon pr={mark} />
      <span className="w-12 shrink-0 truncate text-muted-foreground tabular-nums">#{mark.number}</span>
      <span className="min-w-0 flex-1 truncate">{listing.title}</span>
      {showRepo && (
        <span className="hidden max-w-32 shrink-0 truncate text-muted-foreground @md:inline">
          {rowRepoName(row).split("/").pop()}
        </span>
      )}
      {mark.checksState === "RUNNING" && <ChecksRunningIcon />}
      {listing.commentCount > 0 && (
        <span className="hidden shrink-0 items-center gap-1 text-muted-foreground tabular-nums @sm:flex">
          <MessageSquare className="size-3" />
          {listing.commentCount}
        </span>
      )}
      <Counts added={listing.additions} removed={listing.deletions} className="hidden shrink-0 @lg:inline" />
      {sessions.length > 0 ? (
        <TaskChip tasks={sessions} botOf={botOf} onOpen={onOpenSession} onMany={onPick} className="hidden @md:inline-flex" />
      ) : (
        <span className="hidden w-20 shrink-0 truncate text-muted-foreground/50 @md:inline">
          {listing.isCrossRepository ? "Read only" : "No task"}
        </span>
      )}
      <Avatar src={listing.authorAvatar} name={listing.author} />
      <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
        {relativeTime(listing.updatedAt)}
      </span>
    </div>
  );
}
