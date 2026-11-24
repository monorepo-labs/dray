import { useEffect, useRef, useState } from "react";
import BotAvatar from "@/components/BotAvatar";

import AgentIcon from "@/components/AgentIcon";
import WindowControls from "@/components/layout/WindowControls";
import { GateCards, GateHeading, GateLabel } from "@/components/SignInGate";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { Bot } from "@/types/events";

import Welcome, { PrimaryButton, QuietButton } from "./Welcome";
import { type AgentSetup, type SetupRow, useAgentSetup } from "./agents";
import {
  finishOnboarding,
  replayOnboarding,
  setFreshMachine,
  useFreshMachine,
  useOnboarding,
  useOnboardingPick,
  VARIANTS,
} from "./state";
import "./onboarding.css";

/// How long a ready agent stays on screen before the flow moves on by itself.
const READY_HOLD_MS = 1600;

/// The full-window onboarding, over the app: welcome, agents, Dray Bot. Drawn
/// like the sign-in gate — black, the site's tiles — since it is the brand's
/// own page rather than the app's.
export default function Onboarding({ bot, onStart }: { bot: Bot | undefined; onStart: () => void }) {
  const { variant, run } = useOnboarding();
  return (
    <>
      {import.meta.env.DEV && <DevSwitch />}
      {variant && (
        <Flow
          key={run}
          variant={variant}
          bot={bot}
          onStart={() => {
            finishOnboarding();
            onStart();
          }}
        />
      )}
    </>
  );
}

function Flow({ variant, bot, onStart }: { variant: NonNullable<ReturnType<typeof useOnboarding>["variant"]>; bot: Bot | undefined; onStart: () => void }) {
  const [step, setStep] = useState<"welcome" | "agents" | "bot">("welcome");
  const [seenBot, setSeenBot] = useState(false);
  const setup = useAgentSetup();
  const toBot = () => {
    setSeenBot(true);
    setStep("bot");
  };
  return (
    <div className="fixed inset-0 z-[900] flex flex-col overflow-hidden bg-black text-white select-none">
      <header data-tauri-drag-region="deep" className="relative z-10 flex h-(--titlebar-h,40px) shrink-0 items-center justify-end">
        <WindowControls />
      </header>
      {step === "welcome" && <Welcome variant={variant} bot={bot} onNext={() => setStep("agents")} />}
      {step === "agents" && <Agents setup={setup} auto={!seenBot} onNext={toBot} />}
      {step === "bot" && <MeetBot bot={bot} onBack={() => setStep("agents")} onStart={onStart} />}
    </div>
  );
}

/// Step 1: every agent as a card. One ready is enough, and once one is the
/// flow moves on by itself — the first time through only, so Back from the
/// bot step stays put.
function Agents({ setup, auto, onNext }: { setup: AgentSetup; auto: boolean; onNext: () => void }) {
  const anyReady = setup.ready.length > 0;
  const next = useRef(onNext);
  next.current = onNext;
  useEffect(() => {
    if (!anyReady || !auto) return;
    const timer = setTimeout(() => next.current(), READY_HOLD_MS);
    return () => clearTimeout(timer);
  }, [anyReady, auto]);

  return (
    <main className="relative flex flex-1 items-center justify-center px-10 pb-16">
      <div className="flex w-full max-w-[1040px] flex-col">
        <div className="ob-in">
          <GateLabel>Step 1 of 2 · Agents</GateLabel>
        </div>
        <div className="ob-in" style={{ animationDelay: "80ms" }}>
          <GateHeading>Set up an agent. One is enough.</GateHeading>
        </div>
        <div className="ob-in" style={{ animationDelay: "160ms" }}>
          <GateCards>
            {setup.rows.map((row) => (
              <AgentCard key={row.harness} row={row} onAct={() => setup.act(row.harness)} />
            ))}
          </GateCards>
        </div>
        <div className="ob-in mt-8 flex justify-end gap-2" style={{ animationDelay: "240ms" }}>
          {anyReady ? <PrimaryButton onClick={onNext}>Continue</PrimaryButton> : <QuietButton onClick={onNext}>Skip for now</QuietButton>}
        </div>
      </div>
    </main>
  );
}

const DETAIL: Record<SetupRow["state"], string> = {
  checking: "Checking…",
  ready: "Ready",
  signin: "Sign in",
  install: "Install",
  installing: "Installing…",
  signing: "Finish in Terminal",
  failed: "Try in Terminal",
};

/// The gate's card, with the agent's state in the corner where the gate puts
/// its arrow.
function AgentCard({ row, onAct }: { row: SetupRow; onAct: () => void }) {
  const actionable = row.state === "install" || row.state === "signin" || row.state === "signing" || row.state === "failed";
  const Tag = actionable ? "button" : "div";
  return (
    <Tag
      type={actionable ? "button" : undefined}
      onClick={actionable ? onAct : undefined}
      title={row.state === "failed" ? (row.error ?? undefined) : undefined}
      className={cn(
        "flex h-[200px] min-w-0 flex-1 basis-0 flex-col justify-between bg-[#1C1C1C] p-6 text-left",
        actionable && "cursor-pointer outline-none transition-colors hover:bg-[#242424] focus-visible:bg-[#242424] focus-visible:ring-1 focus-visible:ring-white/40",
      )}
    >
      <span className="flex items-start justify-between">
        <AgentIcon harness={row.harness} className="size-8 text-white/90" />
        <Corner state={row.state} />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="truncate text-[17px] leading-6 tracking-[-0.01em] text-white/80">{row.label}</span>
        <span className={cn("text-[13px] leading-[18px]", actionable ? "text-white/70" : "text-white/40")}>{DETAIL[row.state]}</span>
      </span>
    </Tag>
  );
}

/// A tick for ready, a spinner while something runs, the gate's arrow on a
/// card that does something.
function Corner({ state }: { state: SetupRow["state"] }) {
  if (state === "ready")
    return (
      <span className="flex size-6 items-center justify-center bg-white text-black animate-in zoom-in-50 duration-300">
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
          <path d="M5 12.5 10 17 19 7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square" />
        </svg>
      </span>
    );
  if (state === "checking" || state === "installing" || state === "signing")
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
        <circle cx="12" cy="12" r="9" fill="none" stroke="#FFFFFF33" strokeWidth="2" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="#FFFFFFE6" strokeWidth="2" strokeLinecap="square" />
      </svg>
    );
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path d="M7 17 17 7M7 7h10v10" fill="none" stroke="#FFFFFF66" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/// Step 2: Dray Bot, centred, and what it does.
function MeetBot({ bot, onBack, onStart }: { bot: Bot | undefined; onBack: () => void; onStart: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Enter" && onStart();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStart]);
  return (
    <main className="relative flex flex-1 flex-col items-center justify-center px-10 pb-16 text-center">
      <div className="ob-in">
        <GateLabel flush>Step 2 of 2 · Dray Bot</GateLabel>
      </div>
      <div className="ob-in mt-10" style={{ animationDelay: "100ms" }}>
        <BotAvatar seed={bot?.id ?? "dray"} avatar={bot?.avatar} follow className="size-32" />
      </div>
      <h1 className="ob-in mt-8 text-[44px] leading-[52px] font-light tracking-[-0.03em]" style={{ animationDelay: "200ms" }}>
        Meet Dray Bot.
      </h1>
      <p className="ob-in mt-4 max-w-[560px] text-[17px] leading-[26px] text-white/55" style={{ animationDelay: "280ms" }}>
        One chat for everything you build. Tell it what you want done, and it starts the work on your agents.
      </p>
      <div className="ob-in mt-10 flex w-full max-w-[860px] gap-[2px] text-left" style={{ animationDelay: "380ms" }}>
        <Point title="Starts tasks" text="Ask for a fix or a feature. It opens a task in the right project." />
        <Point title="Keeps track" text="Every task reports back to it, and it tells you when one needs you." />
        <Point title="Remembers" text="What you tell it stays with it, from one chat to the next." />
      </div>
      <div className="ob-in mt-10 flex items-center gap-2" style={{ animationDelay: "480ms" }}>
        <QuietButton onClick={onBack}>Back</QuietButton>
        <PrimaryButton onClick={onStart}>Get started</PrimaryButton>
      </div>
    </main>
  );
}

function Point({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-1 basis-0 flex-col gap-1.5 bg-[#1C1C1C] p-6">
      <span className="text-[17px] leading-6 tracking-[-0.01em] text-white/85">{title}</span>
      <span className="text-[13px] leading-[19px] text-white/45">{text}</span>
    </div>
  );
}

/// ⌘⇧O: pick an opening and play onboarding from the start, or turn it off.
function DevSwitch() {
  const [open, setOpen] = useState(false);
  const pick = useOnboardingPick();
  const fresh = useFreshMachine();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyO") {
        e.preventDefault();
        e.stopPropagation();
        setOpen((was) => !was);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const digit = Number(e.key);
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "0") replayOnboarding(null);
      else if (digit >= 1 && digit <= VARIANTS.length) replayOnboarding(VARIANTS[digit - 1].id);
      else return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  const row = (label: string, key: string, current: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        onClick();
        setOpen(false);
      }}
      className={cn(
        "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-ui hover:bg-muted",
        current && "font-medium",
      )}
    >
      <Kbd>{key}</Kbd>
      <span className="flex-1">{label}</span>
      {current && <span className="text-xs text-muted-foreground">current</span>}
    </button>
  );

  return (
    <div className="fixed top-12 right-3 z-[1001] flex w-72 flex-col rounded-xl bg-popover p-1.5 text-popover-foreground shadow-(--shadow-ring) backdrop-blur-xl animate-in fade-in zoom-in-95">
      <div className="flex items-center justify-between px-2 pt-1 pb-1.5">
        <span className="text-ui font-medium">Onboarding</span>
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>O</Kbd>
        </KbdGroup>
      </div>
      {VARIANTS.map((v, i) => row(v.label, String(i + 1), pick === v.id, () => replayOnboarding(v.id)))}
      {row("Off", "0", pick === null, () => replayOnboarding(null))}
      {/* The row takes the click and the switch only draws its state: a label
          around the switch passed one click on as two and left it unchanged. */}
      <div
        onClick={() => setFreshMachine(!fresh)}
        className="mt-1 flex h-9 cursor-pointer items-center gap-2 border-t border-hairline px-2 pt-1 text-ui"
      >
        <Switch checked={fresh} aria-label="Show agents as not set up" className="pointer-events-none" />
        Show agents as not set up
      </div>
    </div>
  );
}
