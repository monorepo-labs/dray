import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import ChatInput from "@/components/ChatInput";
import EventRow from "@/components/chat/EventRow";
import AutoContinueNotice from "@/components/composer/AutoContinueNotice";
import HandoffRow from "@/components/composer/HandoffRow";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { handoffActions } from "@/lib/handoff";
import type { AgentEvent } from "@/types/events";
import "../App.css";

/// The composer after a Claude Code turn dies on the usage limit (#477): the
/// server sends `continue` a minute after the reset. Cancel turns it off and
/// leaves the way back on; any send drops it. Laid out the way `Chat` and `App` lay it out — the transcript's
/// `max-w-3xl px-6` column over the composer with its handoff row — so what is
/// judged here is what the app draws.

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (cmd: string) => {
    if (cmd === "plugin:event|listen") return 0;
    throw new Error(`demo: nothing stubbed for ${cmd}`);
  },
};

const HOUR = 3600_000;
const reset = new Date(Math.ceil((Date.now() + 2 * HOUR) / HOUR) * HOUR);
const continueAt = () => new Date(reset.getTime() + 60_000).toISOString();

const LIMITED = {
  id: "e1",
  sessionId: "demo",
  harness: "claude_code",
  seq: 1,
  ts: new Date().toISOString(),
  turnId: null,
  subagent: null,
  payload: {
    type: "rate_limited",
    status: "rejected",
    resetsAt: reset.toISOString(),
    limitType: "five_hour",
    overageStatus: "rejected",
    usingOverage: false,
    overageDisabledReason: null,
  },
} as AgentEvent;

function Demo() {
  const [at, setAt] = useState<string | null>(continueAt);
  const [off, setOff] = useState(false);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 pt-6 pb-6">
            <EventRow event={LIMITED} resultByCallId={new Map()} />
          </div>
        </div>
        <ChatInput
          onSend={() => {
            setAt(null);
            setOff(false);
          }}
          cwd="/Users/you/code/acme"
          sessionId="demo-auto-continue"
          handoff={<HandoffRow actions={handoffActions(null, false, true)} onSend={() => {}} />}
          pending={at && <AutoContinueNotice at={at} off={off} onToggle={(on) => setOff(!on)} />}
        />
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
