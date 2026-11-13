import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";

import Chat from "@/components/Chat";
import { TabBody } from "@/components/RightPanel";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import type { AgentEvent, SessionSnapshot } from "@/types/events";
import "../App.css";

/// The real `Chat` inside the real `TabBody`, the way App hides the chat tab.
/// The question: a chat left at the bottom, hidden while replies land, must
/// still be at the bottom when its tab comes back. **Run check** plays that
/// trip for a normal session and a bot chat, each several ways, and puts the
/// verdict in the window title so a script can read it out of Safari too.

const SESSION = "demo-hidden-chat-scroll";

const PICTURE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#2b2b2b"/><text x="40" y="260" font-family="sans-serif" font-size="48" fill="#ddd">A screenshot</text></svg>`,
)}`;

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

/// One exchange: a prompt, a reply and a closed turn.
const exchange = (n: number, picture = false): AgentEvent[] => [
  event({
    type: "user_message",
    text: `Message ${n}`,
    images: picture ? [{ path: null, url: PICTURE, mimeType: "image/svg+xml" }] : [],
    issues: [],
    baseline: null,
    queued: false,
    from: null,
    cwd: null,
  } as AgentEvent["payload"]),
  event({ type: "assistant_text", block: null, text: `Reply ${n}. ${LOREM}\n\n${LOREM}` }),
  event({ type: "turn_completed", status: "success", stopReason: "end_turn", finalText: null, usage: null, durationMs: 1000, head: null, authFailed: false } as AgentEvent["payload"]),
];

/// The agent asking a question: a card that takes the caret once its pane is on screen.
const ask = (n: number): AgentEvent =>
  event({
    type: "questions_asked",
    requestId: `ask${n}`,
    toolUseId: `call${n}`,
    questions: [
      {
        question: `Which way for step ${n}?`,
        header: null,
        multiSelect: false,
        options: [
          { label: "This way", description: null, preview: null },
          { label: "That way", description: null, preview: null },
        ],
        freeText: true,
      },
    ],
  });

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

/// What happens before the reader leaves: nothing, a layout read on the way
/// back, a question asked while away, or a picture opened and wheeled over.
type Leg = "plain" | "layout" | "card" | "lightbox";
const LEGS: Leg[] = ["plain", "layout", "card", "lightbox"];

function Demo() {
  const [events, setEvents] = useState(() => Array.from({ length: 6 }, (_, i) => exchange(i + 1)).flat());
  const [shown, setShown] = useState(true);
  const [bot, setBot] = useState(false);
  const [verdict, setVerdict] = useState("");

  const scroller = () => document.querySelector<HTMLElement>("[data-chat-box] .overflow-y-auto");
  const gap = () => {
    const el = scroller();
    if (!el?.clientHeight) throw new Error("no chat on screen");
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
  };
  const addExchange = (picture = false) =>
    setEvents((all) => [...all, ...exchange(all.length / 3 + 1, picture)]);

  // The lightbox is a portal, outside the scroller in the DOM but inside
  // `Chat` in React's tree, so its wheel events reach the chat's `onWheel`.
  // A synthetic wheel scrolls nothing, which is exactly a wheel over a surface
  // that cannot move the chat.
  const wheelInLightbox = async () => {
    flushSync(() => addExchange(true));
    const el = scroller();
    if (el) el.scrollTop = el.scrollHeight;
    await frames(3);
    const pictures = document.querySelectorAll<HTMLElement>("[data-chat-box] img.sent-image");
    const button = pictures[pictures.length - 1]?.closest("button");
    if (!button) throw new Error("no picture to open");
    button.click();
    await frames(3);
    const dialog = document.querySelector("[role=dialog]");
    if (!dialog) throw new Error("lightbox did not open");
    dialog.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await frames(20);
  };

  // One trip away and back, with replies landing while the tab is hidden.
  const trip = async (leg: Leg) => {
    if (leg === "lightbox") await wheelInLightbox();
    const el = scroller();
    if (el) el.scrollTop = el.scrollHeight;
    await frames(3);
    flushSync(() => setShown(false));
    await frames(2);
    for (let i = 0; i < 3; i++) {
      flushSync(() => addExchange());
      await frames(1);
    }
    if (leg === "card") flushSync(() => setEvents((all) => [...all, ask(all.length)]));
    flushSync(() => setShown(true));
    // Any sibling's layout effect measuring something on that commit.
    if (leg === "layout") void document.body.offsetHeight;
    await frames(4);
    return gap();
  };

  const runCheck = async () => {
    const results: string[] = [];
    for (const isBot of [false, true]) {
      flushSync(() => setBot(isBot));
      await frames(3);
      for (const leg of LEGS) {
        const name = `${isBot ? "bot" : "session"} ${leg}`;
        try {
          const left = await trip(leg);
          results.push(`${name}: ${left < 40 ? "pinned" : `${left}px short`}`);
        } catch (e) {
          results.push(`${name}: ${(e as Error).message}`);
        }
      }
    }
    const pass = results.every((r) => r.endsWith("pinned"));
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
          <h1 className="text-lg font-medium">Chat pinned across a hidden tab</h1>
          <p className="text-ui text-muted-foreground">
            Leave the chat at the bottom, hide it, add replies, show it. It should still sit at the bottom.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setShown((s) => !s)}>
            {shown ? "Hide tab" : "Show tab"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => addExchange()}>
            Add reply
          </Button>
          <Button size="sm" variant="outline" onClick={() => addExchange(true)}>
            Add picture
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
          <TabBody active={shown}>
            <div className="min-h-0 flex-1">
              <Chat
                session={snapshot(events)}
                bot={bot}
                active={shown}
                onOpenSubagent={noop}
                onOpenSession={noop}
                onOpenSubagentPanel={noop}
                onOpenPlan={noop}
                onRespondPermission={noop}
                onAnswerQuestions={noop}
              />
            </div>
          </TabBody>
          {!shown && <p className="m-auto text-ui text-muted-foreground">Another tab</p>}
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
