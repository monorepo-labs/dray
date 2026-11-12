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

  it("reads a send to a bot, its name quoted or bare", () => {
    expect(sentMessages(`dray bot send "Release Ops" "ship it" && dray bot send Research 'look'`)).toEqual([
      { target: "Release Ops", text: "ship it", bot: true },
      { target: "Research", text: "look", bot: true },
    ]);
    expect(sentMessages("dray bot send Ops")).toEqual([]);
    // A send spelled out in a message is text, not a second send.
    expect(sentMessages(`dray bot send Ops 'Reply with dray bot send Research "done"' && dray bot send Keeper hi`)).toEqual([
      { target: "Ops", text: 'Reply with dray bot send Research "done"', bot: true },
      { target: "Keeper", text: "hi", bot: true },
    ]);
    expect(sentMessages("dray bot ls")).toEqual([]);
  });

  it("draws messages to and from other bots, and never folds them", () => {
    const incoming = ev({
      type: "user_message", text: "[message from the Dray bot \"Ops\" (s1)]\n\nhi", images: [], issues: [],
      baseline: null, queued: false, from: { sessionId: "s1", title: "Ops", machine: null, botId: "b1" },
      cwd: null, kickoff: false,
    } as unknown as AgentEventPayload);
    const items = botItems([
      incoming,
      // A bot made in the same command prints an id too, and is not the one
      // the message went to.
      call("a", `dray bot new Scout && dray bot send Ops "thanks, on it"`),
      result("a", `01a1cf3a-0000-7000-8000-000000000000\nMade "Scout".\nSent to bot "Ops" (${ID}).`),
      call("b", `dray session send ${ID} "one"`),
      result("b", "sent"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["botMessage", "botSent", "sent"]);
    expect(items[0]).toMatchObject({ botId: "b1", title: "Ops" });
    expect(items[1]).toMatchObject({ bot: "Ops", botId: ID, text: "thanks, on it" });
    expect(botRows(items).map((r) => r.kind)).toEqual(["botMessage", "botSent", "talk"]);
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

  it("keeps a task and a send made in one command", () => {
    const bot = "01a1cf3a-0000-7000-8000-000000000000";
    const items = botItems([
      call("c", `dray bot send Ops "starting" && dray session new --project /repo "Investigate"`),
      result("c", `Sent to bot "Ops" (${bot}).\n${ID}\nStarted "Investigate"`),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["task", "botSent"]);
    expect(items[0]).toMatchObject({ sessionId: ID });
    expect(items[1]).toMatchObject({ botId: bot });
  });

  it("reads no send out of a new task's brief that names one", () => {
    const sent = "01a1d052-e620-74d4-8ef2-aa9965929e13";
    const started = "01a1d06c-7868-719b-b026-8ad0a260666b";
    const cmd = `D=/private/tmp/images; dray session send ${sent} "User feedback on the sidebar bot rows, screenshot at $D/8.png: make bot rows line up."
dray session new --project /Users/yogesh/Documents/ade --hidden --title "Bot prompt: relay feedback without adding steps" "Edit the Dray bot system prompt. Problem: when a bot passes the user's feedback to one of its tasks with 'dray session send', it adds instructions the user never gave, like 'push to the PR'."`;
    const items = botItems([
      call("c", cmd),
      result("c", `Delivered.\n${started}\nStarted "Bot prompt: relay feedback without adding steps" in worktree gentle-ochre-meadow`),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["task", "sent"]);
    expect(items[0]).toMatchObject({ sessionId: started });
    expect(items[1]).toMatchObject({ target: sent, text: expect.stringContaining("$D/8.png") });
  });

  it("skips a send whose target the shell fills in", () => {
    expect(sentMessages(`for id in aaa bbb; do dray session send "$id" "hello"; done`)).toEqual([]);
    expect(sentMessages(`dray session send $ID hi && dray session send abc12345 'yo'`)).toEqual([
      { target: "abc12345", text: "yo" },
    ]);
  });

  it("reads past a heredoc that spells a send", () => {
    expect(sentMessages(`dray session send aaa "$(cat <<'EOF'\nthen run dray session send bbb "x"\nEOF\n)" && dray session send ccc ok`)).toEqual([
      { target: "aaa", text: `then run dray session send bbb "x"` },
      { target: "ccc", text: "ok" },
    ]);
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
