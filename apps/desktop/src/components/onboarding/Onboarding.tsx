import { type ReactNode, useEffect, useRef, useState } from "react";

import AgentIcon from "@/components/AgentIcon";
import BotAvatar from "@/components/BotAvatar";
import GitHubIcon from "@/components/GitHubIcon";
import WindowControls from "@/components/layout/WindowControls";
import { GateCards } from "@/components/SignInGate";
import { Continue } from "@/components/WhatsNewPage";
import { invoke, LOCAL } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { Bot } from "@/types/events";

import BotTiles from "./BotTiles";
import MuteButton from "./MuteButton";
import Welcome, { SHIMMER_END, SONG_AT } from "./Welcome";
import { type AgentSetup, type GithubSetup, type SetupState, useAgentSetup, useGithubSetup } from "./agents";
import { askToOpenDrayBot, finishOnboarding, useOnboarding } from "./state";
import { startOnboardingMusic } from "./welcomeSounds";
import "./onboarding.css";

/// How long a finished setup stays on screen before the flow moves on by itself.
const READY_HOLD_MS = 1600;
/// The first card's beat of checking, then the gap between each answer.
const FIRST_REVEAL_MS = 900;
const NEXT_REVEAL_MS = 260;

/// The full-window onboarding: welcome, setup, Dray Bot. Drawn like the
/// sign-in gate — black, the site's tiles — since it is the brand's own page
/// rather than the app's. Mounted above the gate, not inside the app, so a new
/// reader meets it before signing in; nothing in it needs an account. Its
/// Continue leads to the gate, and to Dray Bot's chat once the app is in.
export default function Onboarding() {
  const on = useOnboarding();
  if (!on) return null;
  return (
    <Flow
      onStart={() => {
        finishOnboarding();
        askToOpenDrayBot();
      }}
    />
  );
}

/// The flow itself, without the once-per-reader check; the onboarding-mute
/// demo mounts it.
export function Flow({ onStart }: { onStart: () => void }) {
  const [step, setStep] = useState<"welcome" | "setup" | "bot">("welcome");
  // Read here, not handed down by the app, which is not mounted before sign-in.
  // The first read is what makes Dray Bot.
  const [bot, setBot] = useState<Bot>();
  useEffect(() => {
    invoke<Bot[]>("list_bots", {}, LOCAL)
      .then((bots) => setBot(bots.find((b) => b.welcome) ?? bots[0]))
      .catch(() => {});
  }, []);
  const agents = useAgentSetup();
  const github = useGithubSetup();
  // The music comes in under the logo and plays to its end, past onboarding.
  useEffect(() => startOnboardingMusic(SONG_AT, SHIMMER_END), []);
  return (
    // Above the sign-in gate (1000), which it comes before.
    <div className="fixed inset-0 z-[1010] flex flex-col overflow-hidden bg-black text-white select-none">
      <header data-tauri-drag-region="deep" className="relative z-10 flex h-(--titlebar-h,40px) shrink-0 items-center justify-end">
        {step === "bot" && <MuteButton />}
        <WindowControls />
      </header>
      {step === "welcome" && <Welcome onNext={() => setStep("setup")} />}
      {step === "setup" && <Setup agents={agents} github={github} onNext={() => setStep("bot")} />}
      {step === "bot" && <MeetBot bot={bot} onStart={onStart} />}
    </div>
  );
}

/// An agent and `gh`, both required: nothing in Dray runs without an agent, and
/// pull requests, issues and the bot's view of GitHub all go through `gh`. So
/// there is no skip; once both are ready the flow moves on by itself.
function Setup({ agents, github, onNext }: { agents: AgentSetup; github: GithubSetup; onNext: () => void }) {
  const shown = useStagger([...agents.rows.map((r) => r.state), github.state]);
  const ghState = shown[shown.length - 1];
  const done = shown.every((s) => s !== "checking") && agents.ready.length > 0 && ghState === "ready";
  const next = useRef(onNext);
  next.current = onNext;
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => next.current(), READY_HOLD_MS);
    return () => clearTimeout(timer);
  }, [done]);

  return (
    <main className="relative flex flex-1 items-center justify-center px-10 pb-16">
      <div className="flex w-full max-w-[1040px] flex-col">
        <h1 className="ob-in mb-10 text-[36px] leading-10 font-light tracking-[-0.03em]">
          Set up an agent, <span className="text-white/40">one is enough,</span> and GitHub too.
        </h1>
        <div className="ob-in flex flex-col gap-[2px]" style={{ animationDelay: "80ms" }}>
          <GateCards>
            {agents.rows.map((row, i) => (
              <SetupCard
                key={row.harness}
                icon={<AgentIcon harness={row.harness} className="size-8 text-white/90" />}
                label={row.label}
                state={shown[i]}
                error={row.error}
                onAct={() => agents.act(row.harness)}
              />
            ))}
          </GateCards>
          <SetupCard
            wide
            icon={<GitHubIcon className="size-8 text-white/90" />}
            label="GitHub CLI"
            state={ghState}
            error={github.error}
            onAct={github.act}
          />
        </div>
      </div>
    </main>
  );
}

/// Each card reads "checking" for a beat, then its answer lands one card after
/// another, so the reader sees the machine being looked over even when every
/// answer was already in. A card still checking holds the ones after it.
function useStagger(states: SetupState[]): SetupState[] {
  const [shown, setShown] = useState(0);
  const waiting = shown < states.length && states[shown] === "checking";
  useEffect(() => {
    if (shown >= states.length || waiting) return;
    const timer = setTimeout(() => setShown((n) => n + 1), shown === 0 ? FIRST_REVEAL_MS : NEXT_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [shown, waiting, states.length]);
  return states.map((s, i) => (i < shown ? s : "checking"));
}

const DETAIL: Record<SetupState, string> = {
  checking: "Checking…",
  ready: "Ready",
  signin: "Sign in",
  install: "Install",
  installing: "Installing…",
  signing: "Finish signing in",
  failed: "Install by hand",
};

/// The gate's card, with the state in the corner where the gate puts its
/// arrow. `wide` lays a lone card out in a row, icon first, for GitHub.
function SetupCard({
  icon,
  label,
  state,
  error,
  wide = false,
  onAct,
}: {
  icon: ReactNode;
  label: string;
  state: SetupState;
  error: string | null;
  wide?: boolean;
  onAct: () => void;
}) {
  const actionable = state === "install" || state === "signin" || state === "signing" || state === "failed";
  const Tag = actionable ? "button" : "div";
  const text = (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-[17px] leading-6 tracking-[-0.01em] text-white/80">{label}</span>
      <span className={cn("text-[13px] leading-[18px]", actionable ? "text-white/70" : "text-white/40")}>{DETAIL[state]}</span>
    </span>
  );
  return (
    <Tag
      type={actionable ? "button" : undefined}
      onClick={actionable ? onAct : undefined}
      title={state === "failed" ? (error ?? undefined) : undefined}
      className={cn(
        "flex min-w-0 flex-1 basis-0 bg-[#1C1C1C] p-6 text-left",
        wide ? "h-[96px] items-center gap-5" : "h-[190px] flex-col justify-between",
        actionable && "cursor-pointer outline-none transition-colors hover:bg-[#242424] focus-visible:bg-[#242424] focus-visible:ring-1 focus-visible:ring-white/40",
      )}
    >
      {wide ? (
        <>
          {icon}
          <span className="flex-1">{text}</span>
          <Corner state={state} />
        </>
      ) : (
        <>
          <span className="flex items-start justify-between">
            {icon}
            <Corner state={state} />
          </span>
          {text}
        </>
      )}
    </Tag>
  );
}

/// A tick for ready, a spinner while something runs, the gate's arrow on a
/// card that does something.
function Corner({ state }: { state: SetupState }) {
  if (state === "ready")
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" className="shrink-0 animate-in fade-in zoom-in-50 duration-300" aria-hidden>
        <path d="M4.5 12.5 9.5 17.5 19.5 6.5" fill="none" stroke="#FFFFFFE6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (state === "checking" || state === "installing" || state === "signing")
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" className="shrink-0 animate-spin" aria-hidden>
        <circle cx="12" cy="12" r="9" fill="none" stroke="#FFFFFF33" strokeWidth="2" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="#FFFFFFE6" strokeWidth="2" strokeLinecap="square" />
      </svg>
    );
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" className="shrink-0" aria-hidden>
      <path d="M7 17 17 7M7 7h10v10" fill="none" stroke="#FFFFFF66" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/// Dray Bot, and the homepage's four tiles on what it does.
function MeetBot({ bot, onStart }: { bot: Bot | undefined; onStart: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Enter" && onStart();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStart]);
  return (
    // `m-auto` rather than centring on the flex box: centred content taller
    // than a short window spilled off the top, out of the scroll's reach.
    <main className="relative flex min-h-0 flex-1 overflow-y-auto px-10 pb-10">
      <div className="m-auto flex w-full max-w-[960px] flex-col">
        <div className="flex items-start justify-between gap-10">
          <div className="ob-in flex shrink-0 items-center gap-4">
            <BotAvatar seed={bot?.id ?? "dray"} avatar={bot?.avatar} follow className="size-12" />
            <h1 className="text-[36px] leading-10 font-light tracking-[-0.03em]">Meet Dray Bot.</h1>
          </div>
          <div className="ob-in relative flex max-w-[440px] flex-col gap-2 pt-1" style={{ animationDelay: "60ms" }}>
            <svg aria-hidden width="30" height="26" viewBox="0 0 22 19" className="absolute top-1.5 -left-11 fill-white/15">
              <path d="M0 19V9.5L5 0h4L6 9.5h3V19ZM13 19V9.5L18 0h4l-3 9.5h3V19Z" />
            </svg>
            <p className="text-[15px] leading-6 text-white/70">
              Dray Bot is how I work these days. I tell it what I want, and it starts the tasks, keeps them moving and only
              comes back when it needs me. Far calmer than watching every task myself.
            </p>
            <p className="text-[13px] leading-[18px] text-white/40">Yogesh, Founder of Dray</p>
          </div>
        </div>
        <div className="ob-in mt-8" style={{ animationDelay: "120ms" }}>
          <BotTiles />
        </div>
        <div className="ob-in mt-[2px] grid grid-cols-2" style={{ animationDelay: "240ms" }}>
          <Continue row onClose={onStart} className="pl-6 max-lg:pl-6" />
        </div>
      </div>
    </main>
  );
}
