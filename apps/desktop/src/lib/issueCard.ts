import type { AgentEvent, IssueCardRow, IssueRef } from "@/types/events";

export type IssueCardPayload = Extract<AgentEvent["payload"], { type: "issue_card" }>;

/// Each card's issues the reader handed to the agent, by card id.
export type IssueStarts = Map<string, Set<number>>;

export function issueStarts(events: readonly AgentEvent[]): IssueStarts {
  const out: IssueStarts = new Map();
  for (const { payload } of events) {
    if (payload.type !== "issue_approved") continue;
    const card = out.get(payload.cardId) ?? new Set<number>();
    card.add(payload.number);
    out.set(payload.cardId, card);
  }
  return out;
}

/// A stable string for `issueStarts`, so a context built from it changes
/// only when a hand-off lands, not on every event.
export function startsKey(starts: IssueStarts): string {
  return [...starts].map(([card, rows]) => `${card}:${[...rows].join(",")}`).join(";");
}

/// What `openIssue` takes for a row: GitHub's `owner/repo#n` identifier.
export function rowRef(repo: string, row: IssueCardRow): IssueRef {
  return { tracker: "github", id: "", identifier: `${repo}#${row.number}`, title: row.title, url: row.url };
}
