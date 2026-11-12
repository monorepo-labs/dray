import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import { StreamingPreview } from "@/components/Chat";
import BotTranscript from "@/components/chat/BotTranscript";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { appendStreamingText, retireStreamingBlock, startStreamingBlock } from "@/hooks/useStreamingBlock";
import type { AgentEvent } from "@/types/events";
import "../App.css";

/// A bot's chat mid-turn, through the real `BotTranscript` and the real
/// streaming store. The question: does anything but the bot's own reply text
/// draw as a bubble while it works, and does a sent screenshot read whole.

const SESSION = "01a1cfc8-demo-bot-chat";

/// A wide screenshot, the shape the 80px square crop cut to a sliver.
const WIDE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="360"><rect width="1600" height="360" fill="#1b1b1b"/><rect x="40" y="40" width="880" height="80" rx="24" fill="#2b2b2b"/><text x="70" y="92" font-family="sans-serif" font-size="32" fill="#eee">I renamed myself to Dray.</text><rect x="40" y="140" width="1180" height="80" rx="24" fill="#2b2b2b"/><text x="70" y="192" font-family="monospace" font-size="30" fill="#999">Writing 01a1cfc8/INSTRUCTIONS.md +5</text><rect x="900" y="250" width="660" height="80" rx="24" fill="#3a7bd5"/><text x="930" y="302" font-family="sans-serif" font-size="32" fill="#fff">why is this a bubble?</text></svg>`,
)}`;

let seq = 0;
const event = (payload: AgentEvent["payload"]): AgentEvent => ({
  id: `e${seq}`,
  sessionId: SESSION,
  harness: "claude_code",
  seq: seq++,
  ts: new Date(Date.now() - 60_000 + seq * 1000).toISOString(),
  turnId: null,
  subagent: null,
  payload,
});

const user = (text: string, withImage = false) =>
  event({
    type: "user_message",
    text,
    images: withImage ? [{ path: null, url: WIDE, mimeType: "image/svg+xml" }] : [],
    issues: [],
    baseline: null,
    queued: false,
    from: null,
    cwd: null,
  } as AgentEvent["payload"]);

const say = (text: string) => event({ type: "assistant_text", block: null, text });

const EVENTS: AgentEvent[] = [
  user("Find my dray repo and write it down."),
  say("I renamed myself to Dray. Now I'm looking for your dray repo."),
  say("The repo is `@ade` (remote `monorepo-labs/dray`). I'll write that down."),
  user("why is the tool calls and running a command etc showing up in the message bubble? fix it", true),
];

type Phase = "tool" | "bash" | "thinking" | "text" | "idle";

const PHASES: { key: Phase; label: string }[] = [
  { key: "tool", label: "Streaming Write" },
  { key: "bash", label: "Streaming Bash" },
  { key: "thinking", label: "Thinking" },
  { key: "text", label: "Reply text" },
  { key: "idle", label: "Idle" },
];

/// Opens the block each phase stands for, the way `useSessions` does on a `block_start`.
function play(phase: Phase) {
  retireStreamingBlock(SESSION);
  if (phase === "idle") return;
  const tool = phase === "tool" || phase === "bash";
  startStreamingBlock(SESSION, {
    index: 0,
    type: tool ? "tool_use" : phase,
    text: "",
    name: phase === "tool" ? "Write" : phase === "bash" ? "Bash" : null,
    callId: tool ? "call1" : null,
  });
  const text =
    phase === "tool"
      ? `{"file_path":"/Users/me/.dray/bots/01a1cfc8/INSTRUCTIONS.md","content":"# Dray\\n\\nRepo: ade\\nRemote: monorepo-labs/dray\\n\\n"`
      : phase === "thinking"
        ? "The reader wants tool calls out of the bubbles."
        : phase === "text"
          ? "Fixed. Only my replies draw as bubbles now."
          : "";
  if (text) appendStreamingText(SESSION, 0, text);
}

function Demo() {
  const [phase, setPhase] = useState<Phase>("tool");
  useEffect(() => play(phase), [phase]);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4 p-10 pb-24">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">Bot chat while it works</h1>
          <p className="text-ui text-muted-foreground">
            Only reply text should draw as a bubble. A tool call or a thought shows as the orb line.
          </p>
        </div>
        <div className="flex gap-2">
          {PHASES.map((p) => (
            <Button key={p.key} size="sm" variant={p.key === phase ? "default" : "outline"} onClick={() => setPhase(p.key)}>
              {p.label}
            </Button>
          ))}
        </div>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 rounded-xl border border-border px-6 py-6" data-bot-chat>
          <BotTranscript
            unread={false}
            segments={[{ sessionId: SESSION, harness: "claude_code", created: EVENTS[0].ts, events: EVENTS }]}
            busy={phase !== "idle"}
            preview={phase !== "idle" ? <StreamingPreview sessionId={SESSION} /> : undefined}
            onOpenSession={() => {}}
          />
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
