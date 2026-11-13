import { qualify, serverOfSession } from "@/lib/transport";
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
    if (isReaderMessage(events[i])) count++;
    else if (payload.type === "merge_card") after.set(events[i].id, count);
  }
  return after;
}

const isReaderMessage = ({ payload }: AgentEvent) =>
  payload.type === "user_message" && !payload.from && !payload.kickoff;

/// The id of the newest message the reader sent, for the chat to follow a send
/// by. A queued one's delivery is skipped: its send already drew a provisional
/// row, and the flush can land long after, while the reader reads further up.
export function lastSentId(events: readonly AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (isReaderMessage(e) && !(e.payload.type === "user_message" && e.payload.queued)) return e.id;
  }
  return null;
}

/// The repos the cards in a chat name, so their pull requests are read even
/// once the task is settled and no sidebar row asks for them. Qualified with
/// the chat's server, as the card reads them.
export function cardRepos(events: readonly AgentEvent[]): string[] {
  const repos = new Set<string>();
  for (const { sessionId, payload } of events) {
    if (payload.type === "merge_card") repos.add(qualify(payload.projectPath, serverOfSession(sessionId)));
  }
  return [...repos];
}
