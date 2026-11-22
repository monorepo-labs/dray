import { useState, type ReactNode } from "react";
import { ArrowUpRight, PenLine } from "lucide-react";

import AgentIcon from "@/components/AgentIcon";
import BotAvatar from "@/components/BotAvatar";
import WindowControls from "@/components/layout/WindowControls";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Bot } from "@/types/events";

import { AgentAction, StateLine, type AgentSetup } from "./agents";
import { STARTERS } from "./state";

/// Variation A: two full-window steps between sign-in and the app, laid out
/// like the sign-in gate (label, light heading, a row of cards) in the app's
/// own theme.
export default function Steps({
  setup,
  bot,
  onMore,
  onSay,
  onWrite,
  onSkip,
}: {
  setup: AgentSetup;
  bot: Bot | undefined;
  onMore: () => void;
  onSay: (text: string) => void;
  onWrite: () => void;
  onSkip: () => void;
}) {
  const [step, setStep] = useState<0 | 1>(0);
  const none = !setup.checking && setup.ready.length === 0;

  return (
    <div className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-background text-foreground select-none animate-in fade-in">
      <header data-tauri-drag-region="deep" className="flex h-(--titlebar-h,40px) shrink-0 items-center justify-end">
        <WindowControls />
      </header>
      <main className="flex flex-1 items-center justify-center px-10 pb-10">
        <div key={step} className="flex w-full max-w-[960px] flex-col animate-in fade-in slide-in-from-bottom-1">
          {step === 0 ? (
            <>
              <Label>Step 1 of 2 · Agents</Label>
              <Heading>Set up your agents.</Heading>
              <p className="-mt-6 mb-8 text-chat text-muted-foreground">One is enough to start.</p>
              <div className="grid grid-cols-5 gap-2 max-lg:grid-cols-3">
                {setup.rows.map((row) => (
                  <div
                    key={row.harness}
                    className={cn(
                      "flex h-[200px] min-w-0 flex-col justify-between rounded-xl border border-hairline bg-card p-4 shadow-(--shadow-surface)",
                      row.state === "ready" && "border-accent-add/40",
                    )}
                  >
                    <AgentIcon harness={row.harness} brand className="size-7" />
                    <div className="flex flex-col gap-2.5">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-[15px] leading-6 tracking-[-0.01em]">{row.label}</span>
                        <StateLine row={row} />
                      </div>
                      <div className="flex h-7 items-center">
                        <AgentAction row={row} onMore={onMore} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <Footer>
                <Button variant="ghost" onClick={onSkip}>
                  Skip
                </Button>
                <Button onClick={() => setStep(1)}>Continue</Button>
              </Footer>
            </>
          ) : (
            <>
              <Label>Step 2 of 2 · {bot?.name ?? "Dray Bot"}</Label>
              <div className="mt-3.5 mb-8 flex items-center gap-5">
                {bot && <BotAvatar seed={bot.id} avatar={bot.avatar} className="size-16 shrink-0" animate="always" />}
                <div className="flex flex-col gap-1">
                  <h1 className="text-[36px] leading-10 font-light tracking-[-0.03em]">Meet {bot?.name ?? "Dray Bot"}.</h1>
                  <p className="text-chat text-muted-foreground">
                    Tell it what you want done. It starts tasks in your projects and keeps track of them.
                  </p>
                </div>
              </div>
              <div className={cn("grid grid-cols-4 gap-2 max-lg:grid-cols-2", none && "pointer-events-none opacity-40")}>
                {STARTERS.map((text) => (
                  <Card key={text} onClick={() => onSay(text)} corner={<ArrowUpRight className="size-4 text-muted-foreground" />}>
                    {text}
                  </Card>
                ))}
                <Card onClick={onWrite} corner={<PenLine className="size-4 text-muted-foreground" />} muted>
                  Write your own
                </Card>
              </div>
              <Footer>
                {none && <span className="mr-auto text-ui text-muted-foreground">Set up an agent first.</span>}
                <Button variant="ghost" onClick={() => setStep(0)}>
                  Back
                </Button>
              </Footer>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-[11px] leading-[14px] tracking-[0.06em] text-muted-foreground uppercase">{children}</div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h1 className="mt-3.5 mb-8 text-[36px] leading-10 font-light tracking-[-0.03em]">{children}</h1>;
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="mt-8 flex items-center justify-end gap-2">{children}</div>;
}

function Card({
  children,
  corner,
  muted = false,
  onClick,
}: {
  children: ReactNode;
  corner: ReactNode;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[150px] min-w-0 cursor-pointer flex-col justify-between rounded-xl border border-hairline bg-card p-4 text-left shadow-(--shadow-surface) transition-colors outline-none hover:bg-[color-mix(in_oklch,var(--card),var(--foreground)_4%)] focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className="flex justify-end">{corner}</span>
      <span className={cn("text-[15px] leading-6 tracking-[-0.01em]", muted && "text-muted-foreground")}>{children}</span>
    </button>
  );
}
