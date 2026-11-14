import React from "react";
import ReactDOM from "react-dom/client";

import { BotBubble } from "@/components/chat/BotTranscript";
import UserMessage from "@/components/chat/UserMessage";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { setMode, setTheme } from "@/hooks/useTheme";
import { THEMES } from "@/lib/theme";
import "../App.css";

/// A bot's reaction on the reader's message, in a slice of bot chat: each of the
/// three emoji, a long message, and one with no reaction for comparison. The
/// bubbles are the app's own; only the messages are made up.
function Demo() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-6 pt-10 pb-64" data-bot-chat>
      <UserMessage text="Can you fix the login redirect on the pricing page?" reaction="👀" />
      <BotBubble>
        <p className="text-chat">Fixed, PR is up.</p>
      </BotBubble>
      <UserMessage text="Save that as a rule: always check the login first." reaction="✅" />
      <UserMessage text="Thanks, that's great!" reaction="🎉" />
      <UserMessage
        text="The launch went out this morning and we hit a thousand users before lunch. Nothing broke, the dashboards are green, and the support queue is empty."
        reaction="🎉"
      />
      <UserMessage text="What's still open on the billing work?" />
      <BotBubble>
        <p className="text-chat">Two tasks: the invoice PDF and the Stripe webhook retry. Both are waiting on review.</p>
      </BotBubble>
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
