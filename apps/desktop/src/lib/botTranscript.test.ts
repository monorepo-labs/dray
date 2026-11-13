import { describe, expect, it } from "vitest";

import {
  botItems,
  botRows,
  chatItems,
  chatTime,
  drawnSegments,
  firstUnread,
  inReviewTurn,
  itemKey,
  sentMessages,
  startsTimeRun,
  taskContext,
  unreadStart,
} from "@/lib/botTranscript";
import type { AgentEvent, AgentEventPayload } from "@/types/events";

let seq = 0;
const ev = (payload: AgentEventPayload, subagent: string | null = null) =>
  ({ id: `e${seq}`, seq: seq++, payload, subagent }) as unknown as AgentEvent;

const user = (text: string, kickoff = false, queued = false) =>
  ev({ type: "user_message", text, images: [], issues: [], baseline: null, queued, from: null, cwd: null, kickoff } as AgentEventPayload);
const said = (text: string, subagent: string | null = null) =>
  ev({ type: "assistant_text", block: null, text } as AgentEventPayload, subagent);
const done = () => ev({ type: "turn_completed", status: "success" } as unknown as AgentEventPayload);
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
    expect(sentMessages(`dray send abc12345 'it'\\''s done'`)).toEqual([{ target: "abc12345", text: "it's done" }]);
    expect(sentMessages(`dray session send abc12345 "$(cat <<'EOF'\nline one\nline two\nEOF\n)"`)).toEqual([
      { target: "abc12345", text: "line one\nline two" },
    ]);
    expect(sentMessages("dray session ls")).toEqual([]);
  });

  it("reads every send out of one command", () => {
    expect(sentMessages(`dray session send aaaa1111 "hello" && dray session send bbbb2222 'hello'`)).toEqual([
      { target: "aaaa1111", text: "hello" },
      { target: "bbbb2222", text: "hello" },
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
      call("b", `dray session send 01a1d052 "two"`),
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

  it("skips a session send whose target is no session id", () => {
    expect(sentMessages(`dray session send ', it adds' 'push'`)).toEqual([]);
    expect(sentMessages(`for id in aaa bbb; do dray session send "$id" "hello"; done`)).toEqual([]);
    expect(sentMessages(`dray session send $ID hi && dray session send abc12345 'yo'`)).toEqual([
      { target: "abc12345", text: "yo" },
    ]);
  });

  it("reads past a heredoc that spells a send", () => {
    expect(sentMessages(`dray session send aaaa1111 "$(cat <<'EOF'\nthen run dray session send bbbb2222 "x"\nEOF\n)" && dray session send cccc3333 ok`)).toEqual([
      { target: "aaaa1111", text: `then run dray session send bbbb2222 "x"` },
      { target: "cccc3333", text: "ok" },
    ]);
    // The rest of a heredoc's opening line is still commands.
    expect(sentMessages(`cat <<'EOF' >/tmp/brief; dray session send aaaa1111 hi\nsay dray session send bbbb2222 no\nEOF\ndray session send cccc3333 ok`)).toEqual([
      { target: "aaaa1111", text: "hi" },
      { target: "cccc3333", text: "ok" },
    ]);
    // A herestring opens no body; a delimiter may carry a dash.
    expect(sentMessages(`cat <<< "hello"\ndray session send aaaa1111 hi`)).toEqual([{ target: "aaaa1111", text: "hi" }]);
    expect(sentMessages(`cat <<END-TEXT\ndray session send bbbb2222 no\nEND-TEXT\ndray session send cccc3333 ok`)).toEqual([
      { target: "cccc3333", text: "ok" },
    ]);
    expect(sentMessages(`printf '' <<EOF\ndray session send aaaa1111 "example only"`)).toEqual([]);
    // A `<<` inside quotes is text, and opens no heredoc to swallow what follows.
    expect(sentMessages(`dray send aaaa1111 "Explain <<EOF\nsyntax"; dray send bbbb2222 hi\ncat <<EOF\nbody\nEOF`)).toEqual([
      { target: "aaaa1111", text: "Explain <<EOF\nsyntax" },
      { target: "bbbb2222", text: "hi" },
    ]);
  });

  it("draws a hidden review as nothing and each lesson as its own row, undone once taken back", () => {
    const rule = { path: "INSTRUCTIONS.md", kind: "instructions", change: "changed", summary: "Check the login first" };
    const skill = { path: ".claude/skills/fork/SKILL.md", kind: "skill", change: "added", summary: "Fork a sandbox" };
    const items = botItems([
      user("Review: The user just corrected you.", true),
      said("Nothing to keep; that was a one-off."),
      ev({ type: "learned", commit: "abc1234", files: [rule, skill] } as AgentEventPayload),
      ev({ type: "learned_undone", commit: "abc1234", path: skill.path } as AgentEventPayload),
    ]);
    expect(items.map((i) => (i.kind === "learned" ? [i.file.path, i.undone] : i.kind))).toEqual([
      ["INSTRUCTIONS.md", false],
      [".claude/skills/fork/SKILL.md", true],
    ]);
  });

  it("knows a turn a review opened while it streams", () => {
    expect(inReviewTurn([user("hi"), said("hello"), done(), user("Review: x", true)])).toBe(true);
    expect(inReviewTurn([user("Review: x", true), said("…"), user("thanks", false, true)])).toBe(false);
    expect(inReviewTurn([user("start", true)])).toBe(false);
    // Queued behind the reader's message, a review joins their turn.
    const joined = [user("Review: x", true), said("…"), done(), user("rename it"), user("Review: y", true, true)];
    expect(inReviewTurn(joined)).toBe(false);
    expect(inReviewTurn([user("rename it"), said("done"), done(), user("Review: y", true)])).toBe(true);
    // A turn a dead child never closed: a prompt sent with none running opens a new one.
    expect(inReviewTurn([user("rename it"), said("…"), user("Review: y", true)])).toBe(true);
  });

  it("keeps the reply to a turn a review joined, and hides one after a turn left open", () => {
    const joined = botItems([user("rename it"), user("Review: y", true, true), said("Renamed.")]);
    expect(joined.map((i) => i.kind)).toEqual(["user", "assistant"]);
    const open = botItems([user("rename it"), said("Renamed."), user("Review: y", true), said("Kept nothing.")]);
    expect(open.map((i) => i.kind)).toEqual(["user", "assistant"]);
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

describe("taskContext", () => {
  const from = (text: string, sessionId = ID) =>
    ev({
      type: "user_message", text, images: [], issues: [], baseline: null, queued: false,
      from: { sessionId, title: "Pricing page", machine: null }, cwd: null, kickoff: false,
    } as unknown as AgentEventPayload);

  it("finds the task's last report and the bot's words after it, past a stall nudge", () => {
    const report = from("PR is up");
    const reply = said("Pricing is up as #908.");
    const items = botItems([
      from("first try"),
      said("noted"),
      report,
      reply,
      from("Stall nudge: this task has sat idle for 20m, waiting on the user."),
      said("Need line written."),
      user("next thing"),
    ]);
    expect([...taskContext(items, ID)]).toEqual([reply.id]);
  });

  it("falls back to the line that started a task with no reply to point at", () => {
    const start = [call("c1", `dray session new "Pricing"`), result("c1", `${ID}\nStarted`)];
    expect([...taskContext(botItems(start), ID)]).toEqual(["c1"]);
    expect([...taskContext(botItems([...start, from("done")]), ID)]).toEqual(["c1"]);
  });
});

describe("drawnSegments", () => {
  const seg = (id: string, olderBefore: number | null) => ({ id, olderBefore });

  it("draws the newest alone while it is not read back to its start", () => {
    expect(drawnSegments([seg("a", null), seg("b", 120)]).map((s) => s.id)).toEqual(["b"]);
  });

  it("draws each earlier session once the one after it is whole", () => {
    expect(drawnSegments([seg("a", 40), seg("b", null), seg("c", null)]).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(drawnSegments([seg("a", null), seg("b", 40), seg("c", null)]).map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("draws nothing for no sessions", () => {
    expect(drawnSegments([])).toEqual([]);
  });
});

describe("unreadStart", () => {
  it("marks the first reply after the reader's last message, among what was there on opening", () => {
    const [hi, first, two] = [user("hi"), said("one"), said("two")];
    const opened = botItems([hi, first, two]);
    const later = botItems([hi, first, two, user("thanks"), said("welcome")]);
    // A reply that came in after opening is not where unread began.
    expect(unreadStart(later, itemKey(opened.at(-1)!), false)).toBe(first.id);
  });

  it("waits while the reader's last message may sit above what is loaded", () => {
    const old = said("old");
    const items = botItems([old, said("new")]);
    expect(unreadStart(items, itemKey(items.at(-1)!), false)).toBeUndefined();
    // The whole chat loaded and no message of theirs: every reply is unread.
    expect(unreadStart(items, itemKey(items.at(-1)!), true)).toBe(old.id);
  });

  it("marks nothing for a chat opened read", () => {
    expect(unreadStart(botItems([said("x")]), null, false)).toBeNull();
  });
});
