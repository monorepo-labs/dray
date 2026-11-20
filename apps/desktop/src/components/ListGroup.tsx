import { useState, type ReactNode } from "react";

import { ChevronDown, ChevronRight } from "lucide-react";

import GitHubIcon from "@/components/GitHubIcon";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/// The list parts the issues page and the pull requests page share: a group
/// heading that folds its rows, and the repository picker on the header row.

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
export function ListGroup({
  icon,
  label,
  count,
  collapsedByDefault = false,
  onFirstOpen,
  children,
}: {
  /// The glyph beside the label, if the list has one per group.
  icon?: ReactNode;
  label: string;
  /// `null` for a group whose rows have not been read yet — the settled ones
  /// before anybody opens them. A zero there would be a claim, not a blank.
  count: number | null;
  collapsedByDefault?: boolean;
  onFirstOpen?: () => void;
  children: ReactNode;
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
        {icon}
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
export function RepoMenu({
  repo,
  repos,
  onPick,
  placeholder,
  anyLabel,
}: {
  repo: string | null;
  repos: readonly { id: string; name: string }[];
  onPick: (repo: string | null) => void;
  /// What the trigger says with nothing picked.
  placeholder: string;
  /// A first row that picks nothing — every repository — where the list can
  /// draw that.
  anyLabel?: string;
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
            {repo ? repo.slice(repo.indexOf("/") + 1) : placeholder}
          </span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Repository</DropdownMenuLabel>
        {anyLabel && (
          <>
            <DropdownMenuCheckboxItem checked={!repo} onCheckedChange={() => onPick(null)}>
              {anyLabel}
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
          </>
        )}
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
