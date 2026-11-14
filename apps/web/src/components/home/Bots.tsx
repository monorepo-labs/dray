import type { ReactNode } from "react";
import { GitPullRequest, Play, X } from "lucide-react";
import { BotFace } from "@/components/app/Bot";
import { Section, Tile } from "@/components/home/Section";

// Task names double as face seeds, so one task wears one face in every tile.
const PROGRESS = "Progress UI";
const RETRY = "Retry uploads";
const DOCS = "Upload docs";
const FLAKY = "Fix the flaky worktree test";
const API = "Upload API";

/// What a bot does, under the hero: four tiles, each a slice of a bot's chat
/// with its title inside the tile.
export function Bots() {
  return (
    <Section id="bots" className="py-20">
      <div className="grid gap-[2px] lg:grid-cols-2">
        <Tile className="lg:h-[480px]" title="The bot routes your messages to tasks and keeps you informed.">
          <Route />
        </Tile>
        <Tile className="lg:h-[480px]" title="Merge finished work right from the chat.">
          <Merge />
        </Tile>
        <Tile className="lg:h-[480px]" title="Waiting on you catches what you missed.">
          <Waiting />
        </Tile>
        <Tile className="lg:h-[480px]" title="Jump into any task, any time.">
          <Tasks />
        </Tile>
      </div>
    </Section>
  );
}

function Face({ seed, className }: { seed: string; className: string }) {
  return <BotFace still seed={seed} className={`block shrink-0 scale-[1.18] ${className}`} />;
}

const CARD =
  "rounded-2xl border-[0.5px] border-[#FFFFFF33] bg-[#262626] shadow-[0_1px_2px_#00000040,0_8px_24px_-10px_#00000099] light:border-black/10 light:bg-white light:shadow-[0_1px_2px_#0000000F,0_8px_24px_-12px_#00000026]";
const BOT_BUBBLE = "rounded-[14px] bg-[#1F1F1F] px-3 py-2 text-[12px] leading-[17px] text-[#EDEDED] light:bg-white light:text-[#27272A]";

/// The reader's messages, each going to the task it was about, then the
/// bot's report back.
function Route() {
  return (
    <div className="flex flex-col gap-3">
      <Sent>Make the progress bar thinner.</Sent>
      <Messaged task={PROGRESS} />
      <Sent className="pt-1.5">Retry five times, not three.</Sent>
      <Messaged task={RETRY} />
      <div className="pt-2.5">
        <p className={`max-w-[340px] ${BOT_BUBBLE}`}>
          Progress UI is ready to merge. Retry uploads hit a conflict, so I sent it back to rebase.
        </p>
      </div>
    </div>
  );
}

function Sent({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`flex justify-end ${className}`}>
      <p className="max-w-[300px] rounded-[14px] bg-[#1612F8] px-3 py-2 text-[12px] leading-[17px] text-white">{children}</p>
    </div>
  );
}

function Messaged({ task }: { task: string }) {
  return (
    <p className="flex items-center gap-[5px] text-[11px] leading-[14px]">
      <span className="text-[#7C7C7C] light:text-[#71717A]">Messaged</span>
      <Face seed={task} className="size-3.5" />
      <span className="text-[#CFCFCF] light:text-[#3F3F46]">{task}</span>
    </p>
  );
}

/// The task's report with the recording of its work, then the merge card
/// under it.
function Merge() {
  return (
    <div className="mx-auto flex w-full max-w-[360px] flex-col gap-2">
      <p className={`self-start ${BOT_BUBBLE}`}>Progress UI is done. Here&apos;s its recording of the new bar.</p>
      <div className="flex w-[250px] flex-col overflow-clip rounded-[10px] border-[0.5px] border-[#FFFFFF33] bg-[#F2F2F2] light:border-black/10">
        <div className="flex h-4 items-center gap-1 bg-[#E4E4E4] px-2">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-[5px] rounded-full bg-[#C4C4C4]" />
          ))}
        </div>
        <div className="relative flex h-[84px] flex-col justify-between px-4 pt-3 pb-[22px]">
          <span className="text-[9px] leading-[11px] text-[#6A6A6A]">Uploading report.pdf</span>
          <span className="flex h-0.5 rounded-full bg-[#DDDDDD]">
            <span className="w-[62%] rounded-full bg-[#1612F8]" />
          </span>
          <span className="absolute top-7 left-1/2 grid size-7 -translate-x-1/2 place-items-center rounded-full bg-black/60">
            <Play className="size-2.5 translate-x-px fill-white text-white" />
          </span>
          <span className="absolute right-2 bottom-1.5 rounded bg-black/60 px-[5px] text-[9px] leading-3 text-white">0:14</span>
        </div>
      </div>
      <div className={`flex items-center gap-2.5 p-3.5 ${CARD}`}>
        <Face seed={PROGRESS} className="size-7" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-[18px] font-medium text-[#EDEDED] light:text-[#18181B]">{PROGRESS}</p>
          <p className="flex items-center gap-[5px] text-[12px] leading-4 text-[#8A8A8A]">
            <GitPullRequest strokeWidth={1.8} className="size-[13px] text-[#3FB950] light:text-[#1A7F37]" />
            #1032
          </p>
        </div>
        <span className="rounded-[7px] bg-[#238636] px-3.5 py-1.5 text-[12px] leading-4 font-medium text-white">Merge</span>
      </div>
    </div>
  );
}

/// The card at the foot of a bot's chat: every task that needs the reader,
/// with why.
function Waiting() {
  return (
    <div className={`mx-auto flex w-full max-w-[400px] flex-col pt-1 pb-1.5 ${CARD}`}>
      <div className="flex items-center justify-between px-3 py-[7px] text-[11px] leading-[14px] text-[#8A8A8A]">
        Waiting on you
        <X className="size-2.5 text-[#6A6A6A]" />
      </div>
      <div className="flex items-start gap-2.5 px-3 py-1.5">
        <Face seed={RETRY} className="size-[22px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-[3px]">
          <span className="text-[12px] leading-[15px] text-[#EDEDED] light:text-[#18181B]">{RETRY}</span>
          <span className="text-[11px] leading-[14px] text-[#FFFFFFA6] light:text-[#52525B]">Retry a failed chunk three times, or five?</span>
        </div>
        <span className="text-[10px] leading-[18px] text-[#6A6A6A]">12m</span>
      </div>
      <div className="flex items-center gap-2.5 px-3 py-1.5">
        <Face seed={API} className="size-[22px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[12px] leading-[15px] text-[#EDEDED] light:text-[#18181B]">
            {API}
            <span className="text-[10px] leading-[13px] text-[#3FB950] light:text-[#1A7F37]">#1031</span>
          </span>
          <span className="text-[11px] leading-[14px] text-[#FFFFFFA6] light:text-[#52525B]">Checks pass. Ready to merge.</span>
        </div>
        <span className="rounded-[5px] bg-[#238636] px-2 py-[3px] text-[11px] leading-[14px] font-medium text-white">Merge</span>
        <span className="text-[10px] leading-[14px] text-[#6A6A6A]">40m</span>
      </div>
    </div>
  );
}

/// The bot's Tasks tab: every task, what it is doing, and its PR.
function Tasks() {
  return (
    <div className="mx-auto flex w-full max-w-[400px] flex-col text-[12px] leading-4">
      <TaskRow seed={RETRY} status={<span className="text-[#F5A524] light:text-[#B45309]">Waiting on you</span>} />
      <TaskRow seed={DOCS} status="Working" />
      <TaskRow seed={FLAKY} status="Fixing failing checks · 4m" pr={<span className="text-[#F85149] light:text-[#CF222E]">#1010</span>} lit />
      <div className="flex items-center gap-2 px-1 py-[7px]">
        <span className="size-4 shrink-0 rounded-full border-[1.5px] border-dashed border-[#6A6A6A]" />
        <span className="text-[#EDEDED] light:text-[#18181B]">Settings: search box for shortcuts</span>
      </div>
      <TaskRow seed={PROGRESS} pr={<Green>#1032</Green>} />
      <TaskRow seed={API} pr={<Green>#1031</Green>} />
    </div>
  );
}

function TaskRow({ seed, status, pr, lit = false }: { seed: string; status?: ReactNode; pr?: ReactNode; lit?: boolean }) {
  return (
    <div className={`flex gap-2 px-1 py-[7px] ${status ? "items-start" : "items-center"} ${lit ? "rounded-lg bg-[#2E2E2E] light:bg-white" : ""}`}>
      <Face seed={seed} className="size-4" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[#EDEDED] light:text-[#18181B]">{seed}</span>
        {status && <span className="text-[11px] leading-[14px] text-[#7C7C7C] light:text-[#71717A]">{status}</span>}
      </span>
      {pr && <span className="text-[10px] leading-4">{pr}</span>}
    </div>
  );
}

function Green({ children }: { children: ReactNode }) {
  return <span className="text-[#3FB950] light:text-[#1A7F37]">{children}</span>;
}
