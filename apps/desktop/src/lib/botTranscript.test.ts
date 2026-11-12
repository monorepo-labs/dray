import { describe, expect, it } from "vitest";

import { botItems, botRows, chatItems, chatTime, firstUnread, sentMessages, startsTimeRun } from "@/lib/botTranscript";
import type { AgentEvent, AgentEventPayload } from "@/types/events";

let seq = 0;
const ev = (payload: AgentEventPayload, subagent: string | null = null) =>
  ({ id: `e${seq}`, seq: seq++, payload, subagent }) as unknown as AgentEvent;

const user = (text: string, kickoff = false) =>
  ev({ type: "user_message", text, images: [], issues: [], baseline: null, queued: false, from: null, cwd: null, kickoff } as AgentEventPayload);
const said = (text: string, subagent: string | null = null) =>
  ev({ type: "assistant_text", block: null, text } as AgentEventPayload, subagent);
const call = (callId: string, command: string) =>
  ev({ type: "tool_call_started", callId, name: "Bash", input: { command } } as unknown as AgentEventPayload);
const result = (callId: string, text: string, isError = false) =>
  ev({ type: "tool_call_completed", callId, result: { text, isError } } as unknown as AgentEventPayload);

const ID = "01a1c02b-16de-76cb-a29f-11a928a113f8";

describe("botItems", () => {
  it("keeps the conversation and the tasks, nothing else", () => {
    const items = botItems([
      user("start", true),
      said("Hi Yogesh"),
      user("ship the pricing page"),
      call("c1", "ls -la"),
      result("c1", "a b c"),
      call("c2", `dray session new --project /repo "Build the pricing page"`),
      result("c2", `${ID}\nStarted "Pricing page" in worktree calm-owl`),
      said("Started it", "agent-1"),
      said("On it."),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "user", "task", "assistant"]);
    expect(items[2]).toMatchObject({ kind: "task", sessionId: ID });
  });

  it("marks unread from the first reply after the reader's last message", () => {
    const first = said("one");
    const items = botItems([user("hi"), said("old"), user("next"), first, said("two")]);
    expect(firstUnread(items)).toBe(first.id);
    expect(firstUnread(botItems([said("x"), user("read it")]))).toBeNull();
  });

  it("names a task's report-back without its text, and keeps the bot's reply", () => {
    const report = ev({
      type: "user_message", text: "done", images: [], issues: [], baseline: null, queued: false,
      from: { sessionId: ID, title: "Pricing page" }, cwd: null, kickoff: false,
    } as unknown as AgentEventPayload);
    const reply = said("The pricing page is up.");
    const onIt = said("On it.");
    const items = botItems([user("ship it"), onIt, report, reply]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "report", "assistant"]);
    expect(items[2]).toMatchObject({ sessionId: ID, title: "Pricing page" });
    expect(firstUnread(items)).toBe(onIt.id);
  });

  it("draws a message the bot sent a task, and none for a send that failed", () => {
    const items = botItems([
      call("s1", `dray session send ${ID} "Use the \\"plain\\" tone"`),
      result("s1", "sent"),
      call("s2", `dray session send ${ID} 'nope'`),
      result("s2", "no such session", true),
    ]);
    expect(items).toEqual([{ kind: "sent", key: "s1:0", target: ID, text: 'Use the "plain" tone' }]);
  });

  it("reads a sent message out of each shell quoting", () => {
    expect(sentMessages(`dray send abc 'it'\\''s done'`)).toEqual([{ target: "abc", text: "it's done" }]);
    expect(sentMessages(`dray session send abc "$(cat <<'EOF'\nline one\nline two\nEOF\n)"`)).toEqual([
      { target: "abc", text: "line one\nline two" },
    ]);
    expect(sentMessages("dray session ls")).toEqual([]);
  });

  it("reads every send out of one command", () => {
    expect(sentMessages(`dray session send aaa "hello" && dray session send bbb 'hello'`)).toEqual([
      { target: "aaa", text: "hello" },
      { target: "bbb", text: "hello" },
    ]);
  });

  it("folds a run of messages with tasks into one row, broken by anything else", () => {
    const items = botItems([
      call("a", `dray session send ${ID} "one"`),
      result("a", "sent"),
      call("b", `dray session send other-id "two"`),
      result("b", "sent"),
      said("Sent both."),
      call("c", `dray session send ${ID} "three"`),
      result("c", "sent"),
    ]);
    const rows = botRows(items);
    expect(rows.map((r) => (r.kind === "talk" ? r.items.length : r.kind))).toEqual([2, "assistant", 1]);
  });

  it("says the time again only after a pause", () => {
    expect(startsTimeRun(null, "2026-11-11T10:00:00Z")).toBe(true);
    expect(startsTimeRun("2026-11-11T10:00:00Z", "2026-11-11T10:14:59Z")).toBe(false);
    expect(startsTimeRun("2026-11-11T10:00:00Z", "2026-11-11T10:15:00Z")).toBe(true);
  });

  it("labels time vaguer with age", () => {
    const now = new Date(2026, 10, 11, 20, 0);
    expect(chatTime(new Date(2026, 10, 11, 18, 44).toISOString(), now)).toMatch(/^Today 18:44$/);
    expect(chatTime(new Date(2026, 10, 10, 9, 5).toISOString(), now)).toMatch(/^Yesterday 09:05$/);
    expect(chatTime(new Date(2026, 10, 8, 18, 21).toISOString(), now)).toMatch(/^Sunday 18:21$/);
    expect(chatTime(new Date(2026, 10, 1, 18, 21).toISOString(), now)).toMatch(/Nov.*1.*18:21$/);
    expect(chatTime(new Date(2025, 10, 1, 18, 21).toISOString(), now)).toMatch(/2025.*18:21$/);
  });

  it("keeps errors and a failed turn, dropping the text the failure repeats", () => {
    const failed = ev({
      type: "turn_completed", status: "error", stopReason: "stop_sequence", finalText: "Not logged in",
      usage: null, durationMs: null,
    } as unknown as AgentEventPayload);
    const error = ev({ type: "error", source: "harness", message: "boom", fatal: false } as unknown as AgentEventPayload);
    const items = botItems([user("hi"), said("Not logged in"), failed, error]);
    expect(items.map((i) => i.kind)).toEqual(["user", "notice", "notice"]);
  });

  it("draws no task for a create that failed", () => {
    const items = botItems([call("c", "dray session new x"), result("c", `no project ${ID}`, true)]);
    expect(items).toEqual([]);
  });
});

describe("chatItems", () => {
  const segment = (sessionId: string, harness: "claude_code" | "codex", events: AgentEvent[]) => ({
    sessionId,
    harness,
    created: "2026-11-12T00:00:00Z",
    events,
  });

  it("draws every session in order, with a line where the agent changed", () => {
    const items = chatItems([
      segment("a", "claude_code", [user("hi"), said("hello")]),
      segment("b", "codex", [user("still there?"), said("yes")]),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "switch", "user", "assistant"]);
    expect(items[2]).toMatchObject({ kind: "switch", harness: "codex", key: "switch:b" });
  });

  it("draws no line between two sessions on the same agent", () => {
    const items = chatItems([segment("a", "codex", [said("one")]), segment("b", "codex", [said("two")])]);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "assistant"]);
  });
});
