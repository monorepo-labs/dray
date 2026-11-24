import type { AgentEvent, IssueCardRow, IssueLabel, IssueRef } from "@/types/events";

export type IssueCardPayload = Extract<AgentEvent["payload"], { type: "issue_card" }>;

/// The label an approval adds: `READY` in card.rs.
export const READY = "ready";

/// Each card's approvals, by card id then issue number, with the labels the
/// issue carried after. A row approved twice keeps the newest.
export type IssueApprovals = Map<string, Map<number, IssueLabel[]>>;

export function issueApprovals(events: readonly AgentEvent[]): IssueApprovals {
  const out: IssueApprovals = new Map();
  for (const { payload } of events) {
    if (payload.type !== "issue_approved") continue;
    const card = out.get(payload.cardId) ?? new Map<number, IssueLabel[]>();
    card.set(payload.number, payload.labels);
    out.set(payload.cardId, card);
  }
  return out;
}

/// A stable string for `issueApprovals`, so a context built from it changes
/// only when an approval lands, not on every event.
export function approvalsKey(approvals: IssueApprovals): string {
  return [...approvals].map(([card, rows]) => `${card}:${[...rows.keys()].join(",")}`).join(";");
}

/// A row as it stands: its labels after an approval where there was one, and
/// approved where it was approved here or already carries the label.
export function rowState(row: IssueCardRow, approved: Map<number, IssueLabel[]> | undefined) {
  const labels = approved?.get(row.number) ?? row.labels;
  return {
    labels,
    approved: approved?.has(row.number) === true || labels.some((l) => l.name.toLowerCase() === READY),
  };
}

/// What `openIssue` takes for a row: GitHub's `owner/repo#n` identifier.
export function rowRef(repo: string, row: IssueCardRow): IssueRef {
  return { tracker: "github", id: "", identifier: `${repo}#${row.number}`, title: row.title, url: row.url };
}
