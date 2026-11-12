import type { AgentEvent } from "@/types/events";

export type MergeCardPayload = Extract<AgentEvent["payload"], { type: "merge_card" }>;

/// How many of the reader's own messages an unmerged card stays whole for.
/// Collapsing on the very next one hid a PR the reader had not got to yet.
export const FULL_FOR = 3;

/// For each merge card, how many messages the reader has sent since it. Only
/// the reader's: a task's report-back and a bot's message carry `from`, and a
/// bot's kickoff is Dray's own.
export function readerMessagesAfter(events: readonly AgentEvent[]): Map<string, number> {
  const after = new Map<string, number>();
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const { payload } = events[i];
    if (payload.type === "user_message" && !payload.from && !payload.kickoff) count++;
    else if (payload.type === "merge_card") after.set(events[i].id, count);
  }
  return after;
}

/// The repos the cards in a chat name, so their pull requests are read even
/// once the task is settled and no sidebar row asks for them.
export function cardRepos(events: readonly AgentEvent[]): string[] {
  const repos = new Set<string>();
  for (const { payload } of events) if (payload.type === "merge_card") repos.add(payload.projectPath);
  return [...repos];
}
