import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { PrChecksState } from "@/types/events";

/// What a pull request's glyph says, in one place.
///
/// Shared by the panel's header and the sidebar's row mark for [Avatar]'s
/// reason: two copies of a four-way table drift, and the part that drifts is
/// the part actually looked at. The panel draws all four states; the sidebar
/// only ever holds the two it asks for — see `QUERY_MARKS`.
///
/// GitHub's own colours, because the glyph is recognised before it is read:
/// purple for merged, red for closed, muted for a draft that isn't asking to
/// land yet, and `--accent-add` — the app's own green — for open.
const STATES = {
  MERGED: { Icon: GitMerge, tone: "text-accent-merged", label: "Merged" },
  CLOSED: { Icon: GitPullRequestClosed, tone: "text-destructive", label: "Closed" },
  DRAFT: { Icon: GitPullRequestDraft, tone: "text-muted-foreground", label: "Draft" },
  OPEN: { Icon: GitPullRequest, tone: "text-accent-add", label: "Open" },
} as const;

/// Takes the fields rather than a whole PR, so the panel's `PullRequest` and
/// the sidebar's much smaller `PrMark` both fit without either growing a field
/// for the other's sake. `checksState` is one such field — only the mark
/// carries it, and the panel passing nothing reads as nothing to say. Named
/// apart from `PullRequest.checks`, which is a list of individual checks and
/// would collide here.
export type PrStateOf = { state: string; isDraft: boolean; checksState?: PrChecksState };

function keyOf(pr: PrStateOf): keyof typeof STATES {
  if (pr.state === "MERGED") return "MERGED";
  if (pr.state === "CLOSED") return "CLOSED";
  return pr.isDraft ? "DRAFT" : "OPEN";
}

/// Failing CI recolours the pull request's own glyph rather than adding a
/// second mark beside it: a broken build is a fact *about* this PR, and the row
/// has one slot for what state the work is in.
///
/// Only where the PR is still open — a merged one's checks are history, and the
/// purple is what the reader needs from that row. A failing draft still goes
/// red: a draft isn't asking to land, but a broken one still has to be fixed
/// before it can.
function isFailing(pr: PrStateOf): boolean {
  return pr.checksState === "FAILING" && pr.state !== "MERGED" && pr.state !== "CLOSED";
}

/// The word the glyph stands for — the sidebar's `title` needs it in a sentence
/// where the panel needs it on an `aria-label`.
///
/// Colour is not the only carrier of the failure, deliberately: the glyph goes
/// red *and* the label says so, since a red-green difference is the one this
/// palette can least afford to make load-bearing.
export function prStateLabel(pr: PrStateOf): string {
  const label = STATES[keyOf(pr)].label;
  return isFailing(pr) ? `${label}, checks failing` : label;
}

export default function PrStateIcon({
  pr,
  className,
  /// The sidebar draws its mark lighter than the panel draws its header: the
  /// row is a list item the eye scans past, not the subject of the pane.
  strokeWidth,
}: {
  pr: PrStateOf;
  className?: string;
  strokeWidth?: number;
}) {
  const { Icon, tone } = STATES[keyOf(pr)];
  return (
    <Icon
      className={cn("size-3.5 shrink-0", isFailing(pr) ? "text-destructive" : tone, className)}
      strokeWidth={strokeWidth}
      aria-label={prStateLabel(pr)}
    />
  );
}
