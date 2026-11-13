import { describe, expect, it } from "vitest";

import { cardRepos, readerMessagesAfter } from "@/lib/mergeCard";
import { buildTranscript } from "@/lib/transcript";
import type { AgentEvent } from "@/types/events";

let seq = 0;
const event = (payload: object): AgentEvent =>
  ({ id: `e${seq}`, sessionId: "s", harness: "claude_code", seq: seq++, ts: "", turnId: null, subagent: null, payload }) as AgentEvent;

const card = (projectPath = "/repo") =>
  event({ type: "merge_card", taskId: "t", title: "Fix", projectPath, branch: "b", number: 7, url: "u" });
const said = (extra: object = {}) =>
  event({ type: "user_message", text: "hi", images: [], issues: [], baseline: null, queued: false, from: null, cwd: null, ...extra });

describe("readerMessagesAfter", () => {
  it("counts only the reader's messages after each card", () => {
    const first = card();
    const second = card();
    const events = [said(), first, said(), said({ from: { sessionId: "t", title: "Fix" } }), said({ kickoff: true }), second, said()];
    const after = readerMessagesAfter(events);
    expect(after.get(first.id)).toBe(2);
    expect(after.get(second.id)).toBe(1);
  });

  it("reads zero for a card nothing followed", () => {
    const only = card();
    expect(readerMessagesAfter([said(), only]).get(only.id)).toBe(0);
  });
});

describe("cardRepos", () => {
  it("names each repo once", () => {
    expect(cardRepos([card("/a"), said(), card("/a"), card("/b")])).toEqual(["/a", "/b"]);
  });
});

describe("buildTranscript", () => {
  it("keeps a card out of the turn's foldable work", () => {
    const posted = card();
    const [turn] = buildTranscript([said(), event({ type: "assistant_text", block: null, text: "a" }), posted], false).turns;
    expect(turn.cards).toEqual([posted]);
    expect(turn.work.some((w) => "id" in w && w.id === posted.id)).toBe(false);
  });
});
