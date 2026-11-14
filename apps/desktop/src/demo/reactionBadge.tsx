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

/// A bot's reaction on the reader's message. A is the real component; B to H are
/// takes on its look, drawn here on a copy of the bubble, all on the top-left
/// corner where A sits. Each shows in light and dark side by side, each half
/// scoped by its own `data-mode`, so one screenshot judges both.

/// The page colour lifted by `n`% white: opaque, and still the palette's own.
const lift = (n: number) => `color-mix(in oklab, var(--background), white ${n}%)`;
const LIFT = "bg-[color-mix(in_oklab,var(--background),white_7%)]";
const CHIP = "flex items-center justify-center leading-none select-none";
const CORNER = "absolute -top-4 -left-3";

/// The reader's bubble as the bot chat draws it, a badge on its top-left corner.
function Bubble({ text, badge }: { text: string; badge: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="user-bubble relative mt-3 max-w-[85%] rounded-xl bg-card px-3 py-2 text-chat text-card-foreground shadow-(--shadow-card)">
        {text}
        {badge}
      </div>
    </div>
  );
}

/// A tint per reaction, for take G: seen stays neutral, done goes green,
/// celebrate goes amber.
const TINT: Record<string, string> = { "👀": "", "✅": "oklch(0.72 0.17 150)", "🎉": "oklch(0.8 0.16 80)" };

type Take = {
  letter: string;
  name: string;
  note: string;
  draw: (text: string, emoji: string) => ReactNode;
};

const TAKES: Take[] = [
  {
    letter: "A",
    name: "Hairline chip (current)",
    note: "28px circle, a step lighter than the page, 0.5px hairline.",
    draw: (text, emoji) => <UserMessage text={text} reaction={emoji} />,
  },
  {
    letter: "B",
    name: "Bot grey",
    note: "Filled with the bot bubble's grey, no edge: the bot's colour on the reader's message.",
    draw: (text, emoji) => (
      <Bubble
        text={text}
        badge={
          <span className={cn(CHIP, CORNER, "size-7 rounded-full text-[15px]")} style={{ background: lift(14) }}>
            {emoji}
          </span>
        }
      />
    ),
  },
  {
    letter: "C",
    name: "Rounded square",
    note: "The app's own shape: a small tile with the menu-item radius instead of a circle.",
    draw: (text, emoji) => (
      <Bubble
        text={text}
        badge={
          <span className={cn(CHIP, CORNER, LIFT, "size-7 rounded-md border-[0.5px] border-border text-[15px]")}>
            {emoji}
          </span>
        }
      />
    ),
  },
  {
    letter: "D",
    name: "Floating",
    note: "No edge; a soft shadow straight down lifts it off the bubble.",
    draw: (text, emoji) => (
      <Bubble
        text={text}
        badge={
          <span
            className={cn(CHIP, CORNER, LIFT, "size-7 rounded-full text-[15px] shadow-[0_2px_6px_rgb(0_0_0/0.25)]")}
          >
            {emoji}
          </span>
        }
      />
    ),
  },
  {
    letter: "E",
    name: "Tapback tail",
    note: "Two trailing dots running down and out from the chip, as iMessage draws a tapback.",
    draw: (text, emoji) => (
      <Bubble
        text={text}
        badge={
          <span className={cn(CORNER, "-left-4")}>
            <span className={cn(CHIP, LIFT, "size-7 rounded-full border-[0.5px] border-border text-[15px]")}>
              {emoji}
            </span>
            <span className={cn(LIFT, "absolute top-[25px] -left-[3px] size-2 rounded-full border-[0.5px] border-border")} />
            <span className={cn(LIFT, "absolute top-[33px] -left-[7px] size-1 rounded-full border-[0.5px] border-border")} />
          </span>
        }
      />
    ),
  },
  {
    letter: "F",
    name: "Ringed in the bubble's blue",
    note: "Page-coloured chip with a 1.5px ring in the bubble's own fill, tying it to the message.",
    draw: (text, emoji) => (
      <Bubble
        text={text}
        badge={
          <span
            className={cn(CHIP, CORNER, "size-7 rounded-full border-[1.5px] text-[15px]")}
            style={{ background: lift(7), borderColor: "oklch(0.58 0.17 252)" }}
          >
            {emoji}
          </span>
        }
      />
    ),
  },
  {
    letter: "G",
    name: "Tinted by meaning",
    note: "Seen stays neutral; done takes a green wash, celebrate an amber one.",
    draw: (text, emoji) => {
      const tint = TINT[emoji];
      const background = tint ? `color-mix(in oklab, ${lift(7)}, ${tint} 22%)` : lift(7);
      return (
        <Bubble
          text={text}
          badge={
            <span
              className={cn(CHIP, CORNER, "size-7 rounded-full border-[0.5px] border-border text-[15px]")}
              style={{ background }}
            >
              {emoji}
            </span>
          }
        />
      );
    },
  },
  {
    letter: "H",
    name: "Small and quiet",
    note: "22px, emoji at 12px, the page colour itself: a footnote rather than a badge.",
    draw: (text, emoji) => (
      <Bubble
        text={text}
        badge={
          <span
            className={cn(
              CHIP,
              "absolute -top-3 -left-2.5 size-[22px] rounded-full border-[0.5px] border-border bg-background text-[12px]",
            )}
          >
            {emoji}
          </span>
        }
      />
    ),
  },
];

/// One take in a slice of chat: a request the bot is on, its reply, a thanks,
/// and a small thing it did.
function Slice({ take }: { take: Take }) {
  return (
    <div className="flex flex-col gap-4" data-bot-chat>
      {take.draw("Can you fix the login redirect on the pricing page?", "👀")}
      <BotBubble>
        <p className="text-chat">Fixed, PR is up.</p>
      </BotBubble>
      {take.draw("Thanks, that's great!", "🎉")}
      {take.draw("Save that as a rule.", "✅")}
    </div>
  );
}

function Demo() {
  return (
    // Clear of the theme bar on the left, which would cover the last row.
    <main className="mx-auto flex max-w-[1800px] flex-col gap-5 pt-6 pr-6 pb-48 pl-56">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5">
        {TAKES.filter((take) => !only || only.includes(take.letter)).map((take) => (
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

// `?mode=dark&theme=default` opens on that pick, for a screenshot taken without a
// click; `?takes=ABCD` draws only those.
const query = new URLSearchParams(location.search);
const only = query.get("takes")?.toUpperCase();
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
