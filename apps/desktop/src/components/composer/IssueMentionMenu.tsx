import IssueStateIcon, { IssuePriorityIcon } from "@/components/IssueStateIcon";
import PickerMenu from "@/components/composer/PickerMenu";
import type { Issue } from "@/types/events";

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
  onHover,
  placement = "above",
  bare = false,
}: {
  issues: Issue[];
  activeIndex: number;
  onPick: (issue: Issue) => void;
  onHover: (index: number) => void;
  placement?: "above" | "below";
  bare?: boolean;
}) {
  return (
    <PickerMenu
      groups={[{ label: null, items: issues }]}
      label="Issues"
      keyOf={(issue) => issue.id}
      activeIndex={activeIndex}
      onPick={onPick}
      onHover={onHover}
      placement={placement}
      bare={bare}
      renderItem={(issue) => (
        <>
          <IssueStateIcon kind={issue.state.kind} color={issue.state.color} label={issue.state.name} />

          <span className="shrink-0 font-medium tabular-nums">{issue.identifier}</span>

          <span className="min-w-0 truncate text-muted-foreground">{issue.title}</span>

          {/* Trailing, so it can't push the title off its own left edge — and
              absent on most rows, which is what makes it worth reading on the
              few that carry it. */}
          <IssuePriorityIcon priority={issue.priority} className="ml-auto" />
        </>
      )}
    />
  );
}
