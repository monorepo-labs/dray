import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";

import Chat from "@/components/Chat";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { provisionalId } from "@/lib/provisional";
import type { AgentEvent, MessageSender, SessionSnapshot } from "@/types/events";
import "../App.css";

/// The real `Chat`, a session and a bot chat. The question: whatever left the
/// pin down — a scroll up, a stop just short of the end, a wheel that moved
/// nothing — the reader's own send lands in view and the chat follows on from
/// there. A message relayed from a task must not pull a reader reading back.
/// **Run check** puts the verdict in the window title, for Safari too.

const SESSION = "demo-send-scroll";

let seq = 0;
const event = (payload: AgentEvent["payload"]): AgentEvent => ({
  id: `e${seq}`,
  sessionId: SESSION,
  harness: "claude_code",
  seq: seq++,
  ts: new Date(Date.now() - 600_000 + seq * 1000).toISOString(),
  turnId: null,
  subagent: null,
  payload,
});

const LOREM =
  "The pin keeps the newest reply in view. This paragraph is long enough to wrap a few times, so every exchange adds real height to the transcript and the scroller has somewhere to go.";

const prompt = (text: string, from: MessageSender | null = null) =>
  event({
    type: "user_message",
    text,
    images: [],
    issues: [],
    baseline: null,
    queued: false,
    from,
    cwd: null,
  } as AgentEvent["payload"]);

/// What a send draws at once, as `handleSendMsg` does: a provisional row the
/// real message replaces once it is back.
const send = (text: string): AgentEvent => ({ ...prompt(text), id: provisionalId() });

const reply = (n: number) => [
  event({ type: "assistant_text", block: null, text: `Reply ${n}. ${LOREM}\n\n${LOREM}` }),
  event({ type: "turn_completed", status: "success", stopReason: "end_turn", finalText: null, usage: null, durationMs: 1000, head: null, authFailed: false } as AgentEvent["payload"]),
];

const TASK: MessageSender = { sessionId: "demo-task", title: "A task", machine: null } as MessageSender;

const snapshot = (events: AgentEvent[]): SessionSnapshot =>
  ({
    events,
    olderBefore: null,
    sessionId: SESSION,
    harness: "claude_code",
    cwd: "/tmp",
    projectPath: "/tmp",
    branch: null,
    worktreeName: null,
    worktreeRemoved: false,
    title: "Demo",
    titleLocked: false,
  }) as unknown as SessionSnapshot;

const frames = (n: number) =>
  new Promise<void>((done) => {
    const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : done());
    step(n);
  });

const noop = () => {};

/// How the pin went down before the send.
type Leg = "scrolled up" | "just short" | "wheel";
const LEGS: Leg[] = ["scrolled up", "just short", "wheel"];

function Demo() {
  const [events, setEvents] = useState(() =>
    Array.from({ length: 6 }, (_, i) => [prompt(`Message ${i + 1}`), ...reply(i + 1)]).flat(),
  );
  const [bot, setBot] = useState(false);
  const [verdict, setVerdict] = useState("");

  const scroller = () => document.querySelector<HTMLElement>("[data-chat-box] .overflow-y-auto");
  const gap = () => {
    const el = scroller();
    if (!el?.clientHeight) throw new Error("no chat on screen");
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
  };
  const add = (...more: AgentEvent[]) => flushSync(() => setEvents((all) => [...all, ...more]));
  // The real message coming back, under an id of its own.
  const land = (row: AgentEvent) =>
    flushSync(() => setEvents((all) => all.map((e) => (e === row ? { ...row, id: `real-${row.id}` } : e))));

  // Lets the pin go the way a reader would, and checks it really did go.
  const unpin = async (leg: Leg) => {
    const el = scroller();
    if (!el) throw new Error("no chat on screen");
    el.scrollTop = el.scrollHeight;
    await frames(3);
    if (leg === "scrolled up") el.scrollTop = el.scrollHeight / 2;
    if (leg === "just short") el.scrollTop = el.scrollHeight - el.clientHeight - 80;
    // Chromium scrolls nothing for a synthetic wheel, so the pin drops with
    // the view left at the bottom; WebKit scrolls by it, past the bottom band.
    if (leg === "wheel") el.querySelector("p")?.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    await frames(3);
    // A task's report and the bot's answer: new rows a dropped pin leaves below.
    const before = gap();
    add(prompt("A report from a task", TASK), ...reply(seq));
    await frames(3);
    if (gap() <= before) throw new Error(`pin never dropped`);
  };

  const runCheck = async () => {
    const results: string[] = [];
    for (const isBot of [false, true]) {
      flushSync(() => setBot(isBot));
      await frames(3);
      for (const leg of LEGS) {
        const name = `${isBot ? "bot" : "session"} ${leg}`;
        try {
          await unpin(leg);
          const row = send(`Sent after ${leg}`);
          add(row);
          await frames(3);
          const sent = gap();
          land(row);
          // Following on: the reply to the send lands in view too.
          add(...reply(seq));
          await frames(3);
          const followed = gap();
          results.push(
            `${name}: ${sent < 40 && followed < 40 ? "pinned" : `${sent}px short on send, ${followed}px after reply`}`,
          );
        } catch (e) {
          results.push(`${name}: ${(e as Error).message}`);
        }
      }
      // Neither a task's report nor a send's real message landing is a new
      // send: a reader who scrolled up meanwhile stays where they are.
      for (const leg of ["relayed", "landed late"] as const) {
        const name = `${isBot ? "bot" : "session"} ${leg}`;
        try {
          const row = send("Sent, then scrolled up");
          if (leg === "landed late") add(row);
          await unpin("scrolled up");
          const el = scroller()!;
          const top = el.scrollTop;
          if (leg === "relayed") add(prompt("A report from a task", TASK), ...reply(seq));
          else land(row);
          await frames(3);
          results.push(`${name}: ${Math.abs(el.scrollTop - top) < 2 ? "kept place" : `moved ${Math.round(el.scrollTop - top)}px`}`);
        } catch (e) {
          results.push(`${name}: ${(e as Error).message}`);
        }
      }
    }
    const pass = results.every((r) => r.endsWith("pinned") || r.endsWith("kept place"));
    const text = `${pass ? "PASS" : "FAIL"} — ${results.join(", ")}`;
    setVerdict(text);
    document.title = text;
  };

  // `?run` starts the check on load, for a script driving Safari.
  useEffect(() => {
    if (!new URLSearchParams(location.search).has("run")) return;
    // Cancelled on cleanup, or StrictMode's second mount starts a second check.
    const timer = setTimeout(() => void runCheck(), 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col gap-3 p-6 pb-20">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">A send scrolls the chat to the bottom</h1>
          <p className="text-ui text-muted-foreground">
            Scroll up anywhere, then send. Your message should land in view, and the reply after it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => add(send(`Sent ${seq}`))}>
            Send
          </Button>
          <Button size="sm" variant="outline" onClick={() => add(...reply(seq))}>
            Add reply
          </Button>
          <Button size="sm" variant="outline" onClick={() => add(prompt("A report from a task", TASK))}>
            Relay from a task
          </Button>
          <Button size="sm" variant="outline" onClick={() => setBot((b) => !b)}>
            {bot ? "Bot chat" : "Session chat"}
          </Button>
          <Button size="sm" onClick={() => void runCheck()}>
            Run check
          </Button>
          <span className="text-ui text-muted-foreground">{verdict}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border" data-chat-box>
          <div className="min-h-0 flex-1">
          <Chat
            session={snapshot(events)}
            bot={bot}
            active
            onOpenSubagent={noop}
            onOpenSession={noop}
            onOpenSubagentPanel={noop}
            onOpenPlan={noop}
            onRespondPermission={noop}
            onAnswerQuestions={noop}
          />
          </div>
        </div>
      </div>
      <DemoThemeBar />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
