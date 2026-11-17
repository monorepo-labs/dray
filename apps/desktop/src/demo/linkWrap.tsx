import React from "react";
import ReactDOM from "react-dom/client";

import AssistantMessage from "@/components/chat/AssistantMessage";
import { BotBubble } from "@/components/chat/BotTranscript";
import UserMessage from "@/components/chat/UserMessage";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { setMode, setTheme, useTheme } from "@/hooks/useTheme";
import { hasLightMode, THEMES } from "@/lib/theme";
import "../App.css";

/// Long links inside a sentence, in the reader's bubble and the agent's reply,
/// in a bot chat and a task chat, light and dark side by side. A link must run
/// on in the sentence's own line and wrap inside itself, never leave the line
/// or centre its text.

/// Stubbed outside the components, so nothing in `src/` carries a demo seam.
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (called: string, given: Record<string, unknown>) => {
    const cmd = called === "server_invoke" ? (given.cmd as string) : called;
    if (cmd === "list_bots") return [];
    if (cmd === "plugin:event|listen") return 0;
    throw new Error(`demo: nothing stubbed for ${cmd}`);
  },
};

const PROMPTS = [
  'done. their setup prompt "Fetch and execute the appropriate instructions to set me up for Revyl from https://revyl.com/agent-setup/prompt.md?src=first_run&ref=41ff02a965fb773144a6130f"',
  "see https://github.com/monorepo-labs/dray/pull/1160/files#diff-6c1f0a9e2b7d4c3a8f5e1b0d9c7a6e4f2b3c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7 for the change",
  "Read [the setup guide for the agent that runs on first launch](https://revyl.com/agent-setup/prompt.md?src=first_run&ref=41ff02a965fb773144a6130f) and do what it says.",
  "Open www.example.com/a/very/long/path/that/keeps/going/and/going/without/any/spaces/at/all?with=query&and=more then report back.",
];

const REPLY =
  "Set up from https://revyl.com/agent-setup/prompt.md?src=first_run&ref=41ff02a965fb773144a6130f — the [guide](https://revyl.com/agent-setup/prompt.md?src=first_run&ref=41ff02a965fb773144a6130f) is done.";

function Chat({ bot }: { bot: boolean }) {
  return (
    <div className="flex flex-col gap-4" data-bot-chat={bot ? "" : undefined}>
      {PROMPTS.map((text) => (
        <UserMessage key={text} text={text} />
      ))}
      {bot ? (
        <BotBubble>
          <AssistantMessage text={REPLY} />
        </BotBubble>
      ) : (
        <AssistantMessage text={REPLY} />
      )}
    </div>
  );
}

function Demo() {
  const { theme } = useTheme();
  const modes = hasLightMode(theme) ? (["light", "dark"] as const) : (["dark"] as const);
  return (
    <main className="flex flex-col gap-6 pt-6 pr-6 pb-24 pl-56">
      {[true, false].map((bot) => (
        <section key={String(bot)} className="flex flex-col gap-2">
          <p className="text-[13px] font-semibold">{bot ? "Bot chat" : "Task chat"}</p>
          <div className="grid grid-cols-2 gap-3">
            {modes.map((mode) => (
              <div
                key={mode}
                data-theme={theme}
                data-mode={mode}
                className="w-[560px] rounded-xl border border-border bg-background p-4 text-foreground"
              >
                <Chat bot={bot} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

// `?mode=dark&theme=default` opens on that pick, for a screenshot taken without a click.
const query = new URLSearchParams(location.search);
const mode = query.get("mode");
if (mode === "light" || mode === "dark") setMode(mode);
const theme = THEMES.find((t) => t.id === query.get("theme"));
if (theme) setTheme(theme.id);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider>
      <Demo />
      <DemoThemeBar />
    </TooltipProvider>
  </React.StrictMode>,
);
