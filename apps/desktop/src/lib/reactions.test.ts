import { describe, expect, it } from "vitest";

import { botItems } from "@/lib/botTranscript";
import { readerReactions } from "@/lib/reactions";
import type { AgentEvent, AgentEventPayload } from "@/types/events";

let seq = 0;
const ev = (payload: AgentEventPayload) => ({ id: `e${seq}`, seq: seq++, payload, subagent: null }) as unknown as AgentEvent;
const user = (text: string, kickoff = false) =>
  ev({ type: "user_message", text, images: [], issues: [], baseline: null, queued: false, from: null, cwd: null, kickoff } as AgentEventPayload);
const said = (text: string) => ev({ type: "assistant_text", block: null, text } as AgentEventPayload);
const react = (target: AgentEvent, emoji: string, byUser = false) =>
  ev({ type: "reaction", messageId: target.id, emoji, byUser } as AgentEventPayload);

describe("readerReactions", () => {
  it("keeps the reader's newest reaction per message and leaves the bot's out", () => {
    const ask = user("fix it");
    const done = said("Fixed.");
    const more = said("Also bumped the version.");
    const events = [ask, react(ask, "👀"), done, more, react(done, "👍", true), react(done, "❤️", true), react(more, "😂", true)];
    expect(readerReactions(events)).toEqual(
      new Map([
        [done.id, "❤️"],
        [more.id, "😂"],
      ]),
    );
  });

  it("draws neither the reader's reaction nor the note it sent the bot", () => {
    const ask = user("fix it");
    const done = said("Fixed.");
    const items = botItems([ask, done, react(done, "🎉", true), user("The user reacted 🎉 …", true), said("Glad it works!")]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "assistant"]);
    expect(items[0]).toMatchObject({ kind: "user", reaction: undefined });
  });
});
