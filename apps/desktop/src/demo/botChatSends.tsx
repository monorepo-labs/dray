import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import BotTranscript, { type BotTask } from "@/components/chat/BotTranscript";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import type { AgentEvent } from "@/types/events";
import "../App.css";

/// The rows a bot's Bash calls draw in its chat. The question: does one call
/// that sends to a task and starts another, its brief naming `dray session
/// send`, draw one send and one start — and does a loop's `"$id"` draw nothing.

const SESSION = "01a1cfc8-demo-bot-sends";
const SIDEBAR = "01a1d052-e620-74d4-8ef2-aa9965929e13";
const PROMPT = "01a1d06c-7868-719b-b026-8ad0a260666b";
const TASKS: Record<string, string> = {
  [SIDEBAR]: "Sidebar bot rows: inbox style",
  [PROMPT]: "Bot prompt: relay feedback without adding steps",
};

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

const user = (text: string) =>
  event({ type: "user_message", text, images: [], issues: [], baseline: null, queued: false, from: null, cwd: null });
const say = (text: string) => event({ type: "assistant_text", block: null, text });
const bash = (callId: string, command: string, out: string) => [
  event({ type: "tool_call_started", callId, name: "Bash", input: { command } }),
  event({ type: "tool_call_completed", callId, result: { text: out, isError: false } }),
];

const CMD = `D=/private/tmp/images; dray session send ${SIDEBAR} "User feedback on the sidebar bot rows, screenshot at $D/8.png: the selected bot row's highlight sticks out past the edges the other sidebar items line up on. Also reduce the bot row's vertical padding."
dray session new --project /Users/yogesh/Documents/ade --hidden --title "Bot prompt: relay feedback without adding steps" "Edit the Dray bot system prompt at apps/desktop/src-tauri/src/bots/bot_prompt.md. Problem: when a bot passes the user's feedback to one of its tasks with 'dray session send', it adds instructions the user never gave, like 'push to the PR', 'record a video' or 'open a PR'."`;

const EVENTS: AgentEvent[] = [
  user("fix this and also reduce y padding in the bot item"),
  ...bash("c1", CMD, `Delivered.\n${PROMPT}\nStarted "${TASKS[PROMPT]}" in worktree gentle-ochre-meadow`),
  say("Both are going. One task is fixing the bot prompt."),
  user("ping both again"),
  ...bash("c2", `for id in ${SIDEBAR} ${PROMPT}; do dray session send "$id" "status?"; done`, "Delivered.\nDelivered."),
  ...bash("c3", `dray session send 01a1d052 "status?" && dray session send 01a1d06c "status?" && dray session send deadbeef-gone "hello"`, "Delivered.\nDelivered.\nDelivered."),
  say("Asked them both."),
];

const taskOf = (id: string): BotTask | undefined => {
  const full = Object.keys(TASKS).find((t) => t === id || (id.length >= 8 && t.startsWith(id)));
  return full ? { sessionId: full, title: TASKS[full] } : undefined;
};

function Demo() {
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4 p-10 pb-24">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">Bot chat: sends and starts</h1>
          <p className="text-ui text-muted-foreground">
            First call: one send, one start. Second, a loop over <code>"$id"</code>: nothing. Third: the two known tasks, not the gone one.
          </p>
          <p className="text-ui text-muted-foreground" data-opened>
            Opened: {opened ?? "nothing"}
          </p>
        </div>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 rounded-xl border border-border px-6 py-6">
          <BotTranscript
            unread={false}
            segments={[{ sessionId: SESSION, harness: "claude_code", created: EVENTS[0].ts, events: EVENTS }]}
            busy={false}
            taskOf={taskOf}
            onOpenSession={(id) => setOpened(id)}
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
