import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";

import AgentIcon from "@/components/AgentIcon";
import type { Harness } from "@/types/events";
import { cn } from "@/lib/utils";
import "../App.css";

/// Illustrations for What's New highlights, drawn in code rather than
/// screenshotted: small, simplified pieces of Dray's real UI, the way the
/// site's "Ticket to merge" section draws its mocks. Each is a 1280×720 frame,
/// the 16:9 of a highlight's picture, captured to an image for the changelog
/// (`demo/whats-new/<art>.png`), since an image is what every surface reading
/// changelog.json can show — the app, the site, GitHub's release notes and the
/// phones. `?art=<id>` draws one frame alone at the window's corner, for that
/// capture at a 1280×720 viewport; without it every frame is listed.

/// The Dray mark, as the sign-in gate draws it.
const MARK =
  "M101.004 0C104.603 0 107.52 2.926 107.52 6.536V18.301C107.52 36.349 122.108 50.98 140.102 50.98H152.484C156.083 50.98 159 53.907 159 57.516V142.484C159 146.093 156.083 149.02 152.484 149.02H140.102C122.108 149.02 107.52 163.651 107.52 181.699V193.464C107.52 197.074 104.603 200 101.004 200H0.326C0.146 200 0 199.854 0 199.673V134.967C0 134.787 0.146 134.641 0.326 134.641H61.254C79.249 134.641 93.836 120.009 93.836 101.961V98.039C93.836 79.991 79.249 65.36 61.254 65.36H0.326C0.146 65.36 0 65.213 0 65.033V0.327C0 0.146 0.146 0 0.326 0H101.004Z";

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-[720px] w-[1280px] shrink-0 overflow-hidden bg-[#141414] font-sans text-white antialiased">
      {children}
    </div>
  );
}

/// A task moving from Claude Code to Codex: the chat so far, the agent picker
/// open on Codex, and the line the composer shows before the send that moves it.
function AgentSwitch() {
  const agents: [Harness, string][] = [
    ["claude_code", "Claude Code"],
    ["codex", "Codex"],
    ["grok", "Grok"],
    ["pi", "pi"],
  ];
  return (
    <Frame>
      <div className="absolute inset-x-[120px] top-[56px] bottom-[-40px] rounded-[28px] border border-white/10 bg-[#1C1C1C] shadow-[0_24px_80px_#00000080]">
        <div className="flex flex-col gap-7 px-10 pt-9">
          <div className="self-end rounded-[24px] bg-[#2C2C2C] px-7 py-4 text-[26px] leading-9">
            Make the worktree test pass on Linux
          </div>
          <div className="flex max-w-[540px] items-start gap-4 text-[26px] leading-9 text-white/80">
            <AgentIcon harness="claude_code" brand className="mt-1.5 size-7 shrink-0" />
            The temp folder is shared between runs, so the second run finds the first one's files.
          </div>
        </div>
      </div>

      {/* The picker, opened on Codex beside the chat. */}
      <div className="absolute top-[196px] right-[160px] w-[360px] rounded-[22px] border border-white/10 bg-[#262626] p-2.5 shadow-[0_20px_60px_#000000A0]">
        {agents.map(([h, label]) => (
          <div
            key={h}
            className={cn(
              "flex items-center gap-4 rounded-[14px] px-4 py-3.5 text-[25px]",
              h === "codex" ? "bg-white/10 text-white" : "text-white/70",
            )}
          >
            <AgentIcon harness={h} brand className="size-7 shrink-0" />
            <span className="flex-1">{label}</span>
            {h === "codex" && (
              <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden>
                <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        ))}
      </div>

      {/* The composer, and the line over it before the send. */}
      <div className="absolute inset-x-[160px] bottom-[52px] flex flex-col gap-3">
        <div className="flex items-center gap-3 pl-2 text-[24px] font-medium">
          <AgentIcon harness="codex" brand className="size-6" />
          Your next message goes to Codex
        </div>
        <div className="flex h-[96px] items-center justify-between rounded-[30px] border border-white/10 bg-[#262626] pr-4 pl-8 text-[26px] text-white/40">
          Now check it on macOS too
          <span className="flex size-[60px] items-center justify-center rounded-full bg-white">
            <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden>
              <path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="black" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
      </div>
    </Frame>
  );
}

function Row({ dot, title, detail, tone }: { dot: string; title: string; detail: string; tone: string }) {
  return (
    <div className="flex items-start gap-4 border-b border-white/10 py-[18px]">
      <span className={cn("mt-2.5 size-3.5 shrink-0 rounded-full", dot)} />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-[24px] leading-8">{title}</span>
        <span className={cn("text-[19px] leading-6", tone)}>{detail}</span>
      </span>
    </div>
  );
}

/// Dray on an iPhone: the task list with a card waiting on the reader, and a
/// push alert landing beside it.
function IPhone() {
  return (
    <Frame>
      <div className="absolute top-[44px] left-[300px] h-[820px] w-[400px] rounded-[64px] border-[12px] border-[#2B2B2B] bg-black shadow-[0_30px_90px_#000000B0]">
        <div className="mx-auto mt-4 h-[34px] w-[124px] rounded-full bg-[#111]" />
        <div className="px-7 pt-5">
          <div className="text-[44px] leading-[52px] font-semibold tracking-[-0.02em]">Tasks</div>
          <div className="mt-3">
            <Row dot="bg-[#3DD68C]" title="Fix the flaky worktree test" detail="Ready to merge" tone="text-[#3DD68C]" />
            <Row dot="bg-[#FFC53D]" title="Island send sound" detail="Waiting on you" tone="text-[#FFC53D]" />
            <Row dot="bg-[#1612F8]" title="Split panes for bots" detail="Working" tone="text-white/50" />
          </div>
          <div className="mt-6 rounded-[24px] bg-[#1E1E1E] p-5">
            <div className="text-[19px] text-white/50">Island send sound</div>
            <div className="mt-1 font-mono text-[21px] leading-7">pnpm test:affected</div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-[21px]">
              <span className="rounded-[14px] bg-white py-2.5 text-center font-medium text-black">Allow</span>
              <span className="rounded-[14px] bg-white/10 py-2.5 text-center">Deny</span>
            </div>
          </div>
        </div>
      </div>

      {/* A push alert, as iOS draws one, coming in beside the phone. */}
      <div className="absolute top-[300px] left-[610px] w-[520px] rounded-[30px] border border-white/10 bg-[#2A2A2A]/95 p-6 shadow-[0_24px_70px_#000000B0] backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <span className="flex size-[52px] shrink-0 items-center justify-center rounded-[14px] bg-black ring-1 ring-white/15">
            <svg width="22" height="28" viewBox="0 0 159 200" aria-hidden>
              <path d={MARK} fill="white" />
            </svg>
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-baseline justify-between text-[19px] text-white/50">
              DRAY
              <span>now</span>
            </span>
            <span className="text-[24px] leading-8 font-semibold">Ready to merge</span>
          </span>
        </div>
        <div className="mt-2 pl-[68px] text-[22px] leading-8 text-white/80">Fix the flaky worktree test · #1015</div>
      </div>
    </Frame>
  );
}

const ART: Record<string, { name: string; Art: () => ReactNode }> = {
  "agent-switch": { name: "Switching a task's agent", Art: AgentSwitch },
  iphone: { name: "Dray for iPhone", Art: IPhone },
};

function Demo() {
  const one = new URLSearchParams(location.search).get("art");
  if (one && ART[one]) {
    const { Art } = ART[one];
    return <Art />;
  }
  return (
    <div className="flex flex-col gap-10 bg-black p-10 text-white">
      {Object.entries(ART).map(([id, { name, Art }]) => (
        <section key={id} className="flex flex-col gap-3">
          <h2 className="text-ui text-white/60">
            {name} · <span className="font-mono">?art={id}</span>
          </h2>
          <Art />
        </section>
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
