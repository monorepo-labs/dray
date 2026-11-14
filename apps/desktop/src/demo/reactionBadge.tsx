import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";

import { BotBubble } from "@/components/chat/BotTranscript";
import UserMessage from "@/components/chat/UserMessage";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { setMode, setTheme } from "@/hooks/useTheme";
import { THEMES } from "@/lib/theme";
import { cn } from "@/lib/utils";
import "../App.css";

/// A bot's reaction on the reader's message. A is the real component; B to F are
/// takes drawn here on a copy of the bubble. Each shows in light and dark side by
/// side, each half scoped by its own `data-mode`, so one screenshot judges both.

const LIFT = "bg-[color-mix(in_oklab,var(--background),white_7%)]";
const CHIP = "flex items-center justify-center rounded-full leading-none select-none";

/// The reader's bubble as the bot chat draws it, with room for a badge on it,
/// beside it or under it.
function Bubble({
  text,
  on,
  beside,
  under,
  className,
}: {
  text: string;
  on?: ReactNode;
  beside?: ReactNode;
  under?: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] items-end gap-1.5">
        {beside}
        <div className="flex min-w-0 flex-col items-start">
          <div
            className={cn(
              "user-bubble relative rounded-xl bg-card px-3 py-2 text-chat text-card-foreground shadow-(--shadow-card)",
              className,
            )}
          >
            {text}
            {on}
          </div>
          {under}
        </div>
      </div>
    </div>
  );
}

type Take = {
  letter: string;
  name: string;
  note: string;
  draw: (text: string, emoji: string) => ReactNode;
};

const TAKES: Take[] = [
  {
    letter: "A",
    name: "Corner chip (current)",
    note: "28px, a step lighter than the page, 0.5px hairline, on the bottom-left corner.",
    draw: (text, emoji) => <UserMessage text={text} reaction={emoji} />,
  },
  {
    letter: "B",
    name: "Top corner",
    note: "The same chip on the top-left corner, where iMessage puts a tapback.",
    draw: (text, emoji) => (
      <Bubble
        text={text}
        className="mt-3"
        on={
          <span className={cn(CHIP, LIFT, "absolute -top-4 -left-3 size-7 border-[0.5px] border-border text-[15px]")}>
            {emoji}
          </span>
        }
      />
    ),
  },
  {
    letter: "C",
    name: "Bare emoji",
    note: "No chip. The emoji alone on the corner, a soft shadow lifting it off the bubble.",
    draw: (text, emoji) => (
      <Bubble
        text={text}
        className="mb-2"
        on={
          <span className="absolute -bottom-3 left-1.5 text-[18px] leading-none drop-shadow-[0_1px_1.5px_rgb(0_0_0/0.35)] select-none">
            {emoji}
          </span>
        }
      />
    ),
  },
  {
    letter: "D",
    name: "Pill under",
    note: "A small pill below the bubble, not touching it, as Slack and Discord draw them.",
    draw: (text, emoji) => (
      <Bubble
        text={text}
        under={
          <span className={cn(CHIP, LIFT, "mt-1 ml-1 h-6 gap-1 border-[0.5px] border-border px-2 text-[13px]")}>
            {emoji}
          </span>
        }
      />
    ),
  },
  {
    letter: "E",
    name: "Big chip, ring",
    note: "36px, lighter grey, a page-coloured ring and a shadow: the reference screenshot.",
    draw: (text, emoji) => (
      <Bubble
        text={text}
        className="mb-5"
        on={
          <span
            className={cn(
              CHIP,
              "absolute -bottom-6 left-1.5 size-9 bg-[color-mix(in_oklab,var(--background),white_14%)] text-[19px] shadow-[0_1px_3px_rgb(0_0_0/0.3)] ring-2 ring-background",
            )}
          >
            {emoji}
          </span>
        }
      />
    ),
  },
  {
    letter: "F",
    name: "Beside",
    note: "A chip to the left of the bubble, on the bot's side, level with its last line.",
    draw: (text, emoji) => (
      <Bubble
        text={text}
        beside={
          <span className={cn(CHIP, LIFT, "mb-1 size-6 shrink-0 border-[0.5px] border-border text-[13px]")}>
            {emoji}
          </span>
        }
      />
    ),
  },
];

/// One take in a slice of chat: a request the bot is on, its reply, a thanks.
function Slice({ take }: { take: Take }) {
  return (
    <div className="flex flex-col gap-4" data-bot-chat>
      {take.draw("Can you fix the login redirect on the pricing page?", "👀")}
      <BotBubble>
        <p className="text-chat">Fixed, PR is up.</p>
      </BotBubble>
      {take.draw("Thanks, that's great!", "🎉")}
    </div>
  );
}

function Demo() {
  return (
    // Clear of the theme bar on the left, which would cover the last row.
    <main className="mx-auto flex max-w-[1800px] flex-col gap-5 pt-6 pr-6 pb-48 pl-56">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5">
        {TAKES.map((take) => (
          <section key={take.letter} className="flex flex-col gap-2">
            <p className="text-[13px] text-muted-foreground">
              <span className="font-semibold text-foreground">
                {take.letter}. {take.name}
              </span>{" "}
              {take.note}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(["light", "dark"] as const).map((mode) => (
                <div
                  key={mode}
                  data-theme="default"
                  data-mode={mode}
                  className="rounded-xl border border-border bg-background p-4 text-foreground"
                >
                  <Slice take={take} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
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
