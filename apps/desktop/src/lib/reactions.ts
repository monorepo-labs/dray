import type { AgentEvent } from "@/types/events";

/// The reactions there are, the bot's and the reader's alike: `EMOJI` in
/// react.rs, which refuses any other.
export const REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "✅", "👀", "😢"] as const;

export const REACTION_LABELS: Record<string, string> = {
  "👀": "Seen",
  "✅": "Done",
  "🎉": "Celebrating",
  "👍": "Like",
  "👎": "Dislike",
  "❤️": "Love",
  "😂": "Laughing",
  "😢": "Sad",
};

/// The reader's newest reaction on each message, by event id. A bot's
/// reactions are the other way round and drawn by its chat's own rows.
export function readerReactions(events: readonly AgentEvent[]): Map<string, string> {
  const mine = new Map<string, string>();
  for (const { payload } of events) {
    if (payload.type === "reaction" && payload.byUser) mine.set(payload.messageId, payload.emoji);
  }
  return mine;
}
