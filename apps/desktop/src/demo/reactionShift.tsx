import React, { useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";

import BotTranscript from "@/components/chat/BotTranscript";
import { ReactionsContext, type Reactions } from "@/components/chat/Reactions";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { readerReactions } from "@/lib/reactions";
import type { AgentEvent } from "@/types/events";
import "../App.css";

/// A reaction landing on a message. The question: does it move that message
/// or anything after it, and does its badge sit over a neighbour. The chat is
/// the real `BotTranscript`; hover a bot's message to react by hand, or let
/// **Run check** react to every message at three widths and say what moved.

const SESSION = "01a2024a-demo-reaction-shift";
const WIDE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#8ea3b8"/><circle cx="320" cy="180" r="90" fill="#dfe6ee"/></svg>',
)}`;

let seq = 0;
const event = (payload: unknown): AgentEvent =>
  ({
    id: `e${seq}`,
    sessionId: SESSION,
    harness: "claude_code",
    seq: seq++,
    ts: new Date(Date.now() - 60_000 + seq * 1000).toISOString(),
    turnId: null,
    subagent: null,
    payload,
  }) as AgentEvent;

const user = (text: string, image = false) =>
  event({
    type: "user_message",
    text,
    images: image ? [{ path: null, url: WIDE, mimeType: "image/svg+xml" }] : [],
    issues: [],
    baseline: null,
    queued: false,
    from: null,
    cwd: null,
  });
const say = (text: string) => event({ type: "assistant_text", block: null, text });

const LONG =
  "The sidebar row measures its label before the badge mounts, so the first frame draws at the old width and the second at the new one. I moved the measure into the same layout pass, which is why the row no longer twitches when a task flips from working to done.";

/// Every pairing a badge can meet: one line, a tight run, a bubble at full
/// width on either side, a message of a picture alone, and the chat's last row.
const MESSAGES: AgentEvent[] = [
  user("ok ship it"),
  say("On it."),
  say(LONG),
  say("Done."),
  user(`Before you merge, check the narrow pane too. ${LONG}`),
  say("Checked at 320px."),
  user("", true),
  say(`Got the screenshot.\n\n${LONG}`),
  user("and this one", true),
  say("Both look right."),
];

const react = (messageId: string, emoji: string, byUser: boolean) =>
  event({ type: "reaction", messageId, emoji, byUser });

const WIDTHS = [768, 420, 300];
const frames = (n: number) =>
  new Promise<void>((done) => {
    const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : done());
    step(n);
  });

type Box = { el: Element; top: number; left: number; width: number; height: number };
const boxes = (root: HTMLElement): Box[] =>
  [...root.querySelectorAll(".bot-bubble, .user-bubble, .sent-image")].map((el) => {
    const { top, left, width, height } = el.getBoundingClientRect();
    return { el, top, left, width, height };
  });

function Demo() {
  const [reactions, setReactions] = useState<AgentEvent[]>([]);
  const [width, setWidth] = useState(WIDTHS[0]);
  const [verdict, setVerdict] = useState("not run");
  const chat = useRef<HTMLDivElement>(null);

  const events = useMemo(() => [...MESSAGES, ...reactions], [reactions]);
  const context = useMemo<Reactions>(
    () => ({
      mine: readerReactions(events),
      react: (e, emoji) => setReactions((r) => [...r, react(e.id, emoji, true)]),
    }),
    [events],
  );

  const all = () =>
    MESSAGES.map((e, i) =>
      e.payload.type === "user_message" ? react(e.id, i % 2 ? "✅" : "👀", false) : react(e.id, i % 3 ? "❤️" : "👍", true),
    );

  /// Reacts to every message at each width and compares where every bubble and
  /// picture sat before and after, then looks for a badge over a neighbour or
  /// out of the column.
  const check = async () => {
    const said: string[] = [];
    for (const w of WIDTHS) {
      flushSync(() => {
        setWidth(w);
        setReactions([]);
      });
      await frames(2);
      const root = chat.current!;
      const before = boxes(root);
      const tall = root.getBoundingClientRect().height;
      flushSync(() => setReactions(all()));
      await frames(2);

      let moved = 0;
      let worst = 0;
      for (const [i, b] of boxes(root).entries()) {
        const a = before[i];
        const d = Math.max(Math.abs(a.top - b.top), Math.abs(a.left - b.left), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
        if (d > 0.01) moved++;
        worst = Math.max(worst, d);
      }
      worst = Math.max(worst, Math.abs(root.getBoundingClientRect().height - tall));

      // Offsets, not client rects: those take the badge's zoom-in mid-flight.
      const column = root.getBoundingClientRect();
      const badges = [...root.querySelectorAll<HTMLElement>('[role="img"][aria-label*="reacted"]')];
      let over = 0;
      let out = 0;
      for (const badge of badges) {
        const own = badge.offsetParent!;
        const at = own.getBoundingClientRect();
        // The ring is part of what the badge covers.
        const ring = 3;
        const l = at.left + badge.offsetLeft - ring;
        const t = at.top + badge.offsetTop - ring;
        const r = l + badge.offsetWidth + ring * 2;
        const bt = t + badge.offsetHeight + ring * 2;
        if (l < column.left || r > column.right) out++;
        for (const { el } of boxes(root)) {
          if (own.contains(el)) continue;
          const o = el.getBoundingClientRect();
          if (l < o.right && r > o.left && t < o.bottom && bt > o.top) over++;
        }
      }
      const ok = moved === 0 && worst <= 0.01 && over === 0 && out === 0 && badges.length === MESSAGES.length;
      said.push(`${w}px ${ok ? "ok" : `FAIL moved ${moved} by ${worst.toFixed(1)}px, ${over} over a neighbour, ${out} out of the column, ${badges.length}/${MESSAGES.length} badges`}`);
    }
    const pass = said.every((s) => s.endsWith("ok"));
    const line = `${pass ? "PASS" : "FAIL"}: ${said.join("; ")}`;
    setVerdict(line);
    document.title = `reaction-shift ${line}`;
  };

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4 p-10 pb-24">
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-medium">Reaction: nothing moves</h1>
          <p className="text-ui text-muted-foreground">
            Hover a bot's message to react. Run check reacts to every message at {WIDTHS.join(", ")}px and compares every
            bubble's place before and after.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={check}>
              Run check
            </Button>
            <Button size="sm" variant="outline" onClick={() => setReactions(all())}>
              React to all
            </Button>
            <Button size="sm" variant="outline" onClick={() => setReactions([])}>
              Clear
            </Button>
            {WIDTHS.map((w) => (
              <Button key={w} size="sm" variant={w === width ? "secondary" : "ghost"} onClick={() => setWidth(w)}>
                {w}px
              </Button>
            ))}
          </div>
          <p className="text-ui text-muted-foreground" data-verdict>
            Check: {verdict}
          </p>
        </div>
        <ReactionsContext value={context}>
          <div
            ref={chat}
            className="mx-auto flex w-full flex-col gap-4 rounded-xl border border-border px-6 py-6"
            style={{ maxWidth: width }}
            data-bot-chat
          >
            <BotTranscript
              unread={false}
              segments={[{ sessionId: SESSION, harness: "claude_code", created: MESSAGES[0].ts, events }]}
              busy={false}
              onOpenSession={() => {}}
            />
          </div>
        </ReactionsContext>
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
