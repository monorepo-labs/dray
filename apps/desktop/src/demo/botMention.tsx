import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import ChatInput from "@/components/ChatInput";
import UserMessage from "@/components/chat/UserMessage";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { refreshBots, useBots } from "@/lib/bots";
import type { Bot } from "@/types/events";
import "../App.css";

/// The composer in a bot's chat (#941): `@` lists the other bots, not the
/// bot's files, and a pick writes `@Name (id)`, drawn back in the sent bubble
/// as the bot's face and name.

const BOTS: Bot[] = [
  bot("019a3f2c-7b41-7d3e-9f80-000000000001", "Dray Bot", "cloud", 80),
  bot("019a3f2c-7b41-7d3e-9f80-000000000002", "Ops", "hexagon", 185),
  bot("019a3f2c-7b41-7d3e-9f80-000000000003", "Research Bot", "round", 295),
];

function bot(id: string, name: string, shape: string, hue: number): Bot {
  return { id, name, path: `/Users/you/.dray/bots/${id}`, created: "2026-11-01T10:00:00Z", avatar: { shape, hue } };
}

/// Stubbed outside the component, so nothing in `src/` carries a demo seam.
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (called: string, given: Record<string, unknown>) => {
    const cmd = called === "server_invoke" ? (given.cmd as string) : called;
    if (cmd === "list_bots") return BOTS;
    if (cmd === "plugin:event|listen") return 0;
    throw new Error(`demo: nothing stubbed for ${cmd}`);
  },
};
void refreshBots();

function Demo() {
  const [sent, setSent] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  // The chat is Dray Bot's, so it is left out of its own picker.
  const others = useBots().filter((b) => b.id !== BOTS[0].id);

  return (
    <TooltipProvider>
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end gap-4 p-8 pb-24">
        <p className="text-ui text-muted-foreground">
          Dray Bot's chat. Type <code>@</code>: the other bots are listed, not files. Pick one and
          send; the bubble draws the bot's face and name, and a click opens it.
        </p>
        {opened && <p className="text-ui text-muted-foreground">Opened {opened}</p>}
        {sent !== null && (
          <>
            <UserMessage text={sent} onOpenBot={(b) => setOpened(b.name)} />
            <pre data-testid="sent" className="text-ui whitespace-pre-wrap text-muted-foreground">
              {sent}
            </pre>
          </>
        )}
        <ChatInput
          onSend={(message) => setSent(message)}
          cwd={BOTS[0].path}
          bots={others}
          sessionId="demo-bot-mention"
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
