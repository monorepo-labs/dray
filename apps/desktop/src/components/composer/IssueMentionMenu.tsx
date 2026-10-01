import { Check } from "lucide-react";

import IssueStateIcon, { IssuePriorityIcon } from "@/components/IssueStateIcon";
import IssueTrackerChips from "@/components/IssueTrackerChips";
import PickerMenu from "@/components/composer/PickerMenu";
import { shortIdentifier } from "@/lib/issue";
import type { Issue, IssueTracker } from "@/types/events";

/// The `#` picker's rows.
///
/// A flat list always, like the file picker and unlike the command one: the
/// ranking *is* the answer here — assigned to you, unfinished, most urgent
/// first — so a bare `#` already opens on the useful list and there is nothing
/// a heading would separate.
///
/// The identifier leads because it is what gets typed and what lands in the
/// text; the title follows because it is what the row is recognised by. Reverse
/// them and every row starts with a different-length word, which is what makes
/// a list unscannable.
export default function IssueMentionMenu({
  issues,
  activeIndex,
  onPick,
  tagged,
  onHover,
  bare = false,
  loading = false,
  emptyNote,
  tracker,
  canSwitch = false,
}: {
  issues: Issue[];
  activeIndex: number;
  onPick: (issue: Issue, keepOpen: boolean) => void;
  /// Identifiers already tagged in the prompt. Picking one again removes it.
  tagged: Set<string>;
  onHover: (index: number) => void;
  bare?: boolean;
  /// Whether the tracker is still being waited on. The one picker of the three
  /// that needs it: the other two read memory, where this reads the network on
  /// a query nothing has cached yet.
  loading?: boolean;
  /// One line where there is nothing to list and nothing coming — a session
  /// outside a GitHub checkout, under the GitHub tracker.
  emptyNote?: string;
  tracker: IssueTracker;
  /// Whether both trackers are connected. The chips are the reader's way to the
  /// other one's issues without leaving the sentence they are typing; with one
  /// tracker they are two glyphs that can only say what the list already says.
  canSwitch?: boolean;
}) {
  return (
    <PickerMenu
      groups={[{ label: null, items: issues }]}
      label="Issues"
      keyOf={(issue) => issue.id}
      activeIndex={activeIndex}
      onPick={onPick}
      onHover={onHover}
      bare={bare}
      loading={loading}
      emptyNote={emptyNote}
      keepOpenHint
      header={canSwitch ? <IssueTrackerChips tracker={tracker} /> : undefined}
      renderItem={(issue) => (
        <>
          <IssueStateIcon kind={issue.state.kind} color={issue.state.color} label={issue.state.name} />

          {/* Every row here is in the session's own repository, so a GitHub
              identifier says the slug once per row in the column with the least
              room for it. The number is what tells the rows apart. */}
          <span className="shrink-0 font-medium tabular-nums">
            {shortIdentifier(issue.identifier)}
          </span>

          <span className="min-w-0 truncate text-muted-foreground">{issue.title}</span>

          {/* Trailing, so it can't push the title off its own left edge — and
              absent on most rows, which is what makes it worth reading on the
              few that carry it. */}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <IssuePriorityIcon priority={issue.priority} />
            {/* The slot is held on every row once anything is tagged, so the
                priority column stays one column. */}
            {tagged.has(issue.identifier) ? (
              <Check className="size-3.5 text-muted-foreground" aria-label="Tagged" />
            ) : (
              tagged.size > 0 && <span className="size-3.5" />
            )}
          </span>
        </>
      )}
    />
  );
}
