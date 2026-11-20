import type { ReactNode } from "react";
import { Check } from "lucide-react";

import IssueStateIcon, { IssuePriorityIcon } from "@/components/IssueStateIcon";
import IssueTrackerChips from "@/components/IssueTrackerChips";
import PrStateIcon from "@/components/PrStateIcon";
import Segmented from "@/components/Segmented";
import MentionRepoPicker from "@/components/composer/MentionRepoPicker";
import PickerMenu from "@/components/composer/PickerMenu";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { shortIdentifier } from "@/lib/issue";
import { setMentionKind, type MentionKind } from "@/lib/issueTracker";
import type { Issue, IssueTracker, PrMark } from "@/types/events";

const KINDS = [
  { value: "issues", label: "Issues" },
  { value: "prs", label: "PRs" },
] as const;

/// The repository picker a bot's `#` menu carries, since a bot's folder has no
/// remote of its own.
export type RepoPick = {
  repo: string | null;
  repos: readonly string[];
  onPick: (repo: string) => void;
};

/// The `#` picker's rows: issues, or open pull requests, on a switch.
///
/// A flat list always, like the file picker and unlike the command one: the
/// ranking *is* the answer here — issues assigned to you, unfinished, most
/// urgent first; pull requests by latest activity — so a bare `#` already opens
/// on the useful list and there is nothing a heading would separate.
///
/// The identifier leads because it is what gets typed and what lands in the
/// text; the title follows because it is what the row is recognised by. Reverse
/// them and every row starts with a different-length word, which is what makes
/// a list unscannable.
export default function IssueMentionMenu({
  kind,
  issues,
  prs,
  activeIndex,
  onPick,
  onPickPr,
  tagged,
  onHover,
  bare = false,
  loading = false,
  emptyNote,
  tracker,
  canSwitch = false,
  repoPick,
}: {
  kind: MentionKind;
  issues: Issue[];
  prs: { pr: PrMark; identifier: string }[];
  activeIndex: number;
  onPick: (issue: Issue, keepOpen: boolean) => void;
  onPickPr: (pr: { pr: PrMark; identifier: string }, keepOpen: boolean) => void;
  /// Identifiers already tagged in the prompt, lowercased. Picking one again
  /// removes it.
  tagged: Set<string>;
  onHover: (index: number) => void;
  bare?: boolean;
  /// Whether the list is still being waited on. The one picker that needs it:
  /// the others read memory, where this reads the network on a query nothing
  /// has cached yet.
  loading?: boolean;
  /// One line where there is nothing to list and nothing coming — a session
  /// outside a GitHub checkout, under the GitHub tracker.
  emptyNote?: string;
  tracker: IssueTracker;
  /// Whether both trackers are connected. The chips are the reader's way to the
  /// other one's issues without leaving the sentence they are typing; with one
  /// tracker they are two glyphs that can only say what the list already says.
  canSwitch?: boolean;
  repoPick?: RepoPick;
}) {
  // A repo means nothing to Linear's list, which is workspace-wide.
  const showRepo = repoPick && (kind === "prs" || tracker === "github");
  const header = (
    <div className="flex items-center gap-1.5">
      <Segmented value={kind} options={KINDS} onPick={setMentionKind} label="List" />
      {showRepo && <MentionRepoPicker {...repoPick} />}
      {kind === "issues" && canSwitch && <IssueTrackerChips tracker={tracker} className="ml-auto" />}
    </div>
  );
  const hint = (
    <KbdGroup>
      <Kbd>⇧</Kbd>
      <Kbd>⇥</Kbd>
      <span className="ml-0.5">{kind === "issues" ? "PRs" : "issues"}</span>
    </KbdGroup>
  );
  const common = {
    activeIndex,
    onHover,
    bare,
    loading,
    emptyNote,
    keepOpenHint: true,
    header,
    extraHint: hint,
  };
  const check = (identifier: string): ReactNode =>
    // The slot is held on every row once anything is tagged, so the trailing
    // column stays one column.
    tagged.has(identifier.toLowerCase()) ? (
      <Check className="size-3.5 text-muted-foreground" aria-label="Tagged" />
    ) : (
      tagged.size > 0 && <span className="size-3.5" />
    );

  if (kind === "prs") {
    return (
      <PickerMenu
        {...common}
        groups={[{ label: null, items: prs }]}
        label="Pull requests"
        keyOf={(row) => row.pr.url}
        onPick={onPickPr}
        renderItem={({ pr, identifier }) => (
          <>
            <PrStateIcon pr={pr} />
            <span className="shrink-0 font-medium tabular-nums">#{pr.number}</span>
            <span className="min-w-0 truncate text-muted-foreground">{pr.listing?.title}</span>
            <span className="ml-auto flex shrink-0 items-center gap-2">{check(identifier)}</span>
          </>
        )}
      />
    );
  }

  return (
    <PickerMenu
      {...common}
      groups={[{ label: null, items: issues }]}
      label="Issues"
      keyOf={(issue) => issue.id}
      onPick={onPick}
      renderItem={(issue) => (
        <>
          <IssueStateIcon kind={issue.state.kind} color={issue.state.color} label={issue.state.name} />

          {/* Every row here is in one repository, so a GitHub identifier says
              the slug once per row in the column with the least room for it.
              The number is what tells the rows apart. */}
          <span className="shrink-0 font-medium tabular-nums">
            {shortIdentifier(issue.identifier)}
          </span>

          <span className="min-w-0 truncate text-muted-foreground">{issue.title}</span>

          {/* Trailing, so it can't push the title off its own left edge — and
              absent on most rows, which is what makes it worth reading on the
              few that carry it. */}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {/* GitHub has no priority, so its rows would all draw "none". */}
            {issue.tracker !== "github" && <IssuePriorityIcon priority={issue.priority} />}
            {check(issue.identifier)}
          </span>
        </>
      )}
    />
  );
}
