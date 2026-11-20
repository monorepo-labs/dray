import { useEffect, useMemo, useRef, useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronRight, MessageSquare, RefreshCw } from "lucide-react";

import Avatar from "@/components/Avatar";
import GitHubIcon from "@/components/GitHubIcon";
import { MissingCli } from "@/components/PrPanel";
import PrStateIcon, { ChecksRunningIcon } from "@/components/PrStateIcon";
import Segmented from "@/components/Segmented";
import ShortcutKeys from "@/components/ShortcutKeys";
import Counts from "@/components/changes/Counts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PREFETCH_HOVER_MS } from "@/hooks/useHoverPrefetch";
import { prefetchPullRequests } from "@/hooks/usePullRequest";
import { relativeTime } from "@/lib/format";
import {
  SECTIONS,
  inboxSection,
  matchesPeople,
  rowRepoName,
  type InboxRow,
  type PeopleFilter,
} from "@/lib/prInbox";
import { cn } from "@/lib/utils";
import type { PrUnavailable, SessionIndexItem } from "@/types/events";

export type PullsScope = "space" | "all";

const PEOPLE: readonly { value: PeopleFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "review", label: "Review requested" },
];

const SCOPES = [
  { value: "space", label: "This space" },
  { value: "all", label: "All spaces" },
] as const;

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
  scope,
  onScope,
  sessionsFor,
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
  scope: PullsScope;
  onScope: (scope: PullsScope) => void;
  sessionsFor: (row: InboxRow) => SessionIndexItem[];
  picked: InboxRow | null;
  /// `null` closes the pane.
  onPick: (row: InboxRow | null) => void;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [people, setPeople] = useState<PeopleFilter>("all");
  const [repo, setRepo] = useState<string | null>(null);

  const repos = useMemo(() => [...new Set(rows.map(rowRepoName))].sort(), [rows]);
  // A repo picked under another scope may have no rows here; the filter then
  // reads as off rather than hiding the whole list behind a name not listed.
  const repoShown = repo && repos.includes(repo) ? repo : null;
  const shown = rows.filter((row) => matchesPeople(row, people) && (!repoShown || rowRepoName(row) === repoShown));
  const sections = SECTIONS.map((section) => ({
    ...section,
    rows: shown.filter((row) => inboxSection(row.mark) === section.key),
  })).filter((section) => section.rows.length > 0);

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
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pt-3 pb-2">
        {PEOPLE.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setPeople(option.value)}
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

        <Segmented value={scope} options={SCOPES} onPick={onScope} label="Spaces" className="ml-1" />

        <div className="flex-1" aria-hidden />

        <div className="flex shrink-0 items-center gap-1.5">
          {repos.length > 1 && <RepoMenu repo={repoShown} repos={repos} onPick={setRepo} />}
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
            {rows.length > 0
              ? "No pull request matches these filters."
              : scope === "space"
                ? "No open pull requests in this space."
                : "No open pull requests."}
          </p>
        ) : (
          sections.map((section) => (
            <Group key={section.key} label={section.label} count={section.rows.length}>
              {section.rows.map((row) => (
                <PullRow
                  key={row.mark.url}
                  row={row}
                  session={sessionsFor(row).find((s) => !s.archived) ?? null}
                  showRepo={!repoShown && repos.length > 1}
                  picked={picked?.mark.url === row.mark.url}
                  onPick={() => onPick(picked?.mark.url === row.mark.url ? null : row)}
                />
              ))}
            </Group>
          ))
        )}
      </div>
    </div>
  );
}

function Group({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="mb-1.5 last:mb-0">
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-ui text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums">{count}</span>
      </button>
      {!collapsed && children}
    </div>
  );
}

/// One pull request. ⌘-click opens it on GitHub, the issues page's rule; a
/// plain click opens the pane beside the list.
function PullRow({
  row,
  session,
  showRepo,
  picked,
  onPick,
}: {
  row: InboxRow;
  /// The live session behind it, if any — named on the row so a PR nobody is
  /// working on stands out.
  session: SessionIndexItem | null;
  showRepo: boolean;
  picked: boolean;
  onPick: () => void;
}) {
  const { mark, listing } = row;
  // The pane's read starts once the pointer rests here, so a click opens on an
  // answer rather than on a `gh` round trip; sweeping past reads nothing.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const arm = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => prefetchPullRequests(row.key, mark.headRefName), PREFETCH_HOVER_MS);
  };
  const disarm = () => clearTimeout(timer.current);
  useEffect(() => disarm, []);

  return (
    <div
      role="button"
      tabIndex={0}
      onPointerEnter={arm}
      onPointerLeave={disarm}
      onFocus={arm}
      onBlur={disarm}
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
      <span
        className={cn(
          "hidden max-w-36 shrink-0 truncate @lg:inline",
          session ? "text-muted-foreground" : "text-muted-foreground/50",
        )}
        title={session ? `Session: ${session.title}` : "No live session"}
      >
        {session ? session.title : "No session"}
      </span>
      <Avatar src={listing.authorAvatar} name={listing.author} />
      <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
        {relativeTime(listing.updatedAt)}
      </span>
    </div>
  );
}

function RepoMenu({ repo, repos, onPick }: { repo: string | null; repos: string[]; onPick: (repo: string | null) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-ui transition-colors",
            repo ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <GitHubIcon className="size-3.5" />
          <span className="max-w-40 truncate">{repo ? repo.slice(repo.indexOf("/") + 1) : "All repositories"}</span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Repository</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={!repo} onCheckedChange={() => onPick(null)}>
          All repositories
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {repos.map((name) => (
          <DropdownMenuCheckboxItem key={name} checked={repo === name} onCheckedChange={() => onPick(name)}>
            {name}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
