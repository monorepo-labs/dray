import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";

import Chat from "@/components/Chat";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { setOlderDropper, setOlderLoader } from "@/lib/olderPages";
import type { AgentEvent, MessageSender, SessionSnapshot } from "@/types/events";
import "../App.css";

/// The real `Chat` as a bot chat sixty exchanges long, and a row picked from
/// its "Waiting on you" card. The question: the chat glides from its bottom to
/// the bot's reply about the task and stays there — whether that reply is in
/// the drawn tail or far above it, and whether a reply lands mid-glide — and
/// that what it read is let go again once the reader is back at the bottom.
/// `?paged` reads it from a fake log a page at a time, as the app does.
/// **Run check** puts the verdict in the window title, for Safari too.

const SESSION = "demo-bot-focus";
const OLD: MessageSender = { sessionId: "demo-old-task", title: "Move the index to SQLite", machine: null } as MessageSender;
const RECENT: MessageSender = { sessionId: "demo-recent-task", title: "Fix the pricing copy", machine: null } as MessageSender;

let seq = 0;
const event = (payload: AgentEvent["payload"]): AgentEvent => ({
  id: `e${seq}`,
  sessionId: SESSION,
  harness: "claude_code",
  seq: seq++,
  ts: new Date(Date.now() - 3_600_000 + seq * 10_000).toISOString(),
  turnId: null,
  subagent: null,
  payload,
});

const LOREM =
  "Long enough to wrap a few times, so every exchange adds real height and the chat has somewhere to scroll to.";

const message = (text: string, from: MessageSender | null = null) =>
  event({ type: "user_message", text, images: [], issues: [], baseline: null, queued: false, from, cwd: null } as AgentEvent["payload"]);

const reply = (text: string) => [
  event({ type: "assistant_text", block: null, text: `${text} ${LOREM}` }),
  event({ type: "turn_completed", status: "success", stopReason: "end_turn", finalText: null, usage: null, durationMs: 1000, head: null, authFailed: false } as AgentEvent["payload"]),
];

/// Sixty exchanges: the old task reports at the eighth, far above the 24
/// turns a bot chat draws while it follows the bottom; the recent one at the
/// fifty-fifth, inside them.
const EVENTS = Array.from({ length: 60 }, (_, i) =>
  i === 7
    ? [message("Here is the migration plan. Go ahead?", OLD), ...reply("The SQLite task wants your go-ahead on its plan.")]
    : i === 54
      ? [message("Opened #908, ready to merge.", RECENT), ...reply("Pricing copy is in #908 and ready to merge.")]
      : [message(`Message ${i + 1}`), ...reply(`Reply ${i + 1}.`)],
).flat();

const snapshot = (events: AgentEvent[], olderBefore: number | null): SessionSnapshot =>
  ({
    events,
    olderBefore,
    sessionId: SESSION,
    harness: "claude_code",
    cwd: "/tmp",
    projectPath: "/tmp",
    branch: null,
    worktreeName: null,
    worktreeRemoved: false,
    title: "Ops",
    titleLocked: false,
  }) as unknown as SessionSnapshot;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const noop = () => {};
const taskOf = (id: string) => [OLD, RECENT].find((t) => t.sessionId === id);

/// `?paged`: the chat opens on its last 30 exchanges and reads the rest from a
/// fake log, a page every 300ms, as a remote server answers.
const PAGED = new URLSearchParams(location.search).has("paged");
const TAIL = PAGED ? EVENTS.length - 30 * 3 : 0;

function Demo() {
  const [events, setEvents] = useState(EVENTS);
  // Where in the log the held events start.
  const [from, setFrom] = useState(TAIL);
  // How many events the session holds, for the trim leg.
  const held = useRef(0);
  held.current = events.length - from;
  useEffect(() => {
    let reading = false;
    setOlderLoader((_, turns = 16) => {
      if (reading) return;
      reading = true;
      setTimeout(() => {
        reading = false;
        setFrom((at) => Math.max(0, at - turns * 3));
      }, 300);
    });
    setOlderDropper((_, keepFrom) =>
      setFrom((at) => Math.max(at, keepFrom ? EVENTS.findIndex((e) => e.id === keepFrom) : TAIL)),
    );
  }, []);
  const [focus, setFocus] = useState<{ sessionId: string; at: number } | null>(null);
  const [verdict, setVerdict] = useState("");

  const scroller = () => document.querySelector<HTMLElement>("[data-chat-box] .overflow-y-auto");
  const pick = (task: MessageSender) => setFocus({ sessionId: task.sessionId, at: Date.now() });
  const land = () => flushSync(() => setEvents((all) => [...all, message("Another thing"), ...reply("On it.")]));

  const toBottom = async () => {
    const el = scroller()!;
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
    await sleep(600);
  };

  /// Grows the chat with no React commit for half a second, as a highlight or
  /// an image landing does: what a pin re-armed mid-glide answers.
  const grow = async () => {
    const pad = document.querySelector<HTMLElement>("[data-bot-chat]");
    if (!pad) return;
    for (let i = 0; i < 30; i++) {
      pad.style.paddingBottom = `${i * 2}px`;
      await sleep(16);
    }
    pad.style.paddingBottom = "";
  };

  const runCheck = async () => {
    const results: string[] = [];
    for (const task of [OLD, RECENT]) {
      for (const live of ["", "reply", "growth"] as const) {
        const name = `${task === OLD ? "far" : "near"}${live && ` + ${live}`}`;
        await toBottom();
        pick(task);
        if (live === "reply") {
          await sleep(120);
          land();
        }
        if (live === "growth") void grow();
        await sleep(2500);
        const el = scroller()!;
        const block = document.querySelector<HTMLElement>("[data-bot-focus]");
        const at = block && Math.round(block.getBoundingClientRect().top - el.getBoundingClientRect().top);
        results.push(`${name}: ${at === null ? "block gone" : at >= -2 && at < 150 ? "landed" : `${at}px off`}`);
      }
    }
    // Back at the bottom, what the jump read and drew is let go again.
    const rows = () => document.querySelector("[data-bot-chat]")?.children.length ?? 0;
    await toBottom();
    const before = { rows: rows(), held: held.current };
    pick(OLD);
    await sleep(2500);
    const jumped = { rows: rows(), held: held.current };
    await toBottom();
    await sleep(600);
    const back = { rows: rows(), held: held.current };
    const trimmed = back.rows === before.rows && back.held === before.held;
    results.push(
      `trim: ${trimmed ? "trimmed" : "kept"} (rows ${before.rows}→${jumped.rows}→${back.rows}, events ${before.held}→${jumped.held}→${back.held})`,
    );
    const pass = results.every((r) => r.endsWith("landed") || r.startsWith("trim: trimmed"));
    const text = `${pass ? "PASS" : "FAIL"} — ${results.join(", ")}`;
    setVerdict(text);
    document.title = text;
  };

  // `?run` starts the check on load, for a script driving Safari.
  useEffect(() => {
    if (!new URLSearchParams(location.search).has("run")) return;
    // Cancelled on cleanup, or StrictMode's second mount starts a second check.
    const timer = setTimeout(() => void runCheck(), 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col gap-3 p-6 pb-20">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">A Waiting on you pick jumps to its message</h1>
          <p className="text-ui text-muted-foreground">
            The old task's reply sits far above the drawn tail; the recent one's inside it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => pick(OLD)}>
            Pick old task
          </Button>
          <Button size="sm" variant="outline" onClick={() => pick(RECENT)}>
            Pick recent task
          </Button>
          <Button size="sm" variant="outline" onClick={land}>
            Add reply
          </Button>
          <Button size="sm" onClick={() => void runCheck()}>
            Run check
          </Button>
          <span className="text-ui text-muted-foreground">{verdict}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border" data-chat-box>
          <div className="min-h-0 flex-1">
            <Chat
              session={snapshot(events.slice(from), from > 0 ? from : null)}
              bot
              active
              taskOf={taskOf}
              botFocus={focus}
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
