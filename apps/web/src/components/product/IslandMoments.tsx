import type { ReactNode } from "react";
import { Check } from "lucide-react";

import { ScaledWindow } from "@/components/illustrations/ScaledWindow";
import { Rail } from "./Rail";
import { MenuBar } from "./Desktop";
import { CARD_BG_FLIPPED } from "./Stage";
import {
  AskHeader,
  AttentionPill,
  DonePill,
  InputRow,
  ISLAND_W,
  NewSessionBar,
  NOTCH_H,
  NotchCard,
  PermissionBody,
  QuestionBody,
  Switcher,
  SYSTEM_FONT,
  TitleRow,
} from "./Island";
import s from "./hero.module.css";

/// Each tile is a crop of the desktop at this size, in points, scaled to its
/// column. Wide enough that Island hangs at its real 520pt.
const TILE_W = 700;
const TILE_H = 396;

/// Everything else Island does, one tile each: the pills that say when to
/// look, a question, a new task, the screenshot, a permission card, the switcher.
export function IslandMoments({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Rail label="What Island does">
        <Tile title="Know when to look" line="A pill in the notch when a task needs you or is done. Nothing at all otherwise.">
          <MenuBar compact />
          <div className="absolute top-0 left-1/2 -translate-x-1/2">
            <div className={s.alertA}>
              <div className={s.glow}>
                <AttentionPill />
              </div>
            </div>
          </div>
          <div className="absolute top-0 left-1/2 -translate-x-1/2">
            <div className={s.alertB}>
              <DonePill title="Sign-in screen" />
            </div>
          </div>
        </Tile>

        <Tile title="Answer its questions" line="Pick an option or write your own. The agent carries on the moment you do.">
          <Hanging>
            <AskHeader title="Passkey sign-in" />
            <QuestionBody
              question="Which sign-in should ship first?"
              of="1 of 3"
              options={[
                { label: "Passkeys", detail: "WebAuthn, no password to leak" },
                { label: "Email link", detail: "A one-time link, works everywhere" },
              ]}
              picked={0}
            />
          </Hanging>
        </Tile>

        <Tile title="Start a new task" line="⌘N: pick the agent, the model, the project and a fresh worktree right there.">
          <Hanging>
            <div className="flex flex-col gap-2">
              <TitleRow title="New task" working={false} />
              <NewSessionBar />
              <InputRow running={false} />
            </div>
          </Hanging>
          <div
            className="absolute rounded-xl bg-black p-1 text-[13px] text-white/80 shadow-[0_4px_12px_rgba(0,0,0,.35)]"
            style={{ ...SYSTEM_FONT, top: NOTCH_H + 12 + 18 + 8 + 26 + 6, right: (TILE_W - ISLAND_W) / 2 + 12, width: 180 }}
          >
            {["Auto", "Plan", "Ask every time", "Bypass permissions"].map((m, i) => (
              <div key={m} className={`flex h-7 items-center rounded-md px-2.5 ${i === 0 ? "bg-white/[0.12] text-white" : ""}`}>
                {m}
                {i === 0 && <Check className="ml-auto size-3.5" strokeWidth={2.5} />}
              </div>
            ))}
          </div>
        </Tile>

        <Tile title="Grab part of the screen" line="⌘⇧2 drops a region straight into the prompt. Draw on it first, if a circle says it faster.">
          <Chart />
          <div className="absolute inset-0 overflow-hidden" style={{ top: NOTCH_H }}>
            <div
              className={`absolute ${s.region}`}
              style={{ left: 150, top: 70, outline: "1px solid white", boxShadow: "0 0 0 2000px rgba(0,0,0,.35)" }}
            />
          </div>
          <div
            className="absolute bottom-5 left-1/2 flex h-9 -translate-x-1/2 items-center gap-1 rounded-full bg-black px-1.5 text-[13px] text-white shadow-[0_4px_12px_rgba(0,0,0,.35)]"
            style={SYSTEM_FONT}
          >
            <span className="rounded-full bg-white/[0.12] px-3 py-1">Full screen</span>
            <span className="px-3 py-1 text-white/70">Cancel</span>
          </div>
        </Tile>

        <Tile title="Answer permission cards" line="Allow once, always, or deny, by number. Tabs when several sessions are waiting.">
          <Hanging>
            <AskHeader title="Fix the flaky checkout test" tabs={["Fix the flaky checkout test", "Migrate billing"]} />
            <PermissionBody
              tool="Bash"
              description="Run the checkout tests"
              argument="pnpm vitest run checkout --reporter=dot"
              options={[{ label: "Allow" }, { label: "Always allow pnpm vitest" }, { label: "Deny", deny: true }]}
              picked={0}
            />
          </Hanging>
        </Tile>

        <Tile title="Jump between tasks" line="↑↓ lists every session, with the ones waiting on you marked.">
          <Hanging>
            <div className="flex flex-col gap-2">
              <TitleRow title="Ship the onboarding flow" />
              <InputRow running={false} />
            </div>
          </Hanging>
          <div className="absolute left-1/2 -translate-x-1/2" style={{ top: NOTCH_H + 112 + 8, width: ISLAND_W }}>
            <div className="relative">
              <Switcher
                rows={[
                  { title: "Sign-in screen", project: "acme-web", status: "waiting" },
                  { title: "Onboarding copy", project: "acme-web", status: "done" },
                  { title: "Analytics events", project: "acme-api" },
                  { title: "Nightly backup script", project: "infra" },
                ]}
                selected={-1}
              />
              <span
                aria-hidden
                className={`absolute inset-x-2 h-8 rounded-lg bg-white/[0.12] ${s.walk}`}
                style={{ top: 8 + 32 + 4 }}
              />
            </div>
          </div>
        </Tile>
      </Rail>
    </div>
  );
}

/// One moment: the scene, then what it is.
function Tile({ title, line, children }: { title: string; line: string; children: ReactNode }) {
  return (
    <article className="w-[82vw] max-w-[420px] shrink-0 snap-start overflow-hidden rounded-2xl border-[0.5px] border-white/[0.03] bg-white/[0.1]">
      <ScaledWindow width={TILE_W} height={TILE_H}>
        <div aria-hidden className="relative h-full w-full select-none overflow-hidden" style={CARD_BG_FLIPPED}>
          {children}
        </div>
      </ScaledWindow>
      <div className="px-5 py-4">
        <h3 className="font-medium">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">{line}</p>
      </div>
    </article>
  );
}

/// Island open, hanging from the top of the screen at its real width. No
/// menu bar: at this crop the card covers all but its corners.
function Hanging({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="absolute top-0 left-1/2 -translate-x-1/2">
        <NotchCard style={{ width: ISLAND_W, paddingTop: NOTCH_H + 12 }} className="px-3 pb-3">
          {children}
        </NotchCard>
      </div>
    </>
  );
}

/// A dashboard behind the screenshot tile: something worth grabbing.
function Chart() {
  const bars = [38, 52, 44, 70, 58, 86, 64, 92, 74, 60, 98, 82];
  return (
    <>
      <MenuBar compact />
      <div
        className="absolute rounded-xl bg-[#18181b] p-5 text-[#fafafa] ring-1 ring-white/10"
        style={{ ...SYSTEM_FONT, left: 60, top: NOTCH_H + 26, width: 480, height: 250 }}
      >
        <p className="text-[12px] text-[#a1a1aa]">Weekly sign-ups</p>
        <p className="text-[22px] font-semibold">12,480</p>
        <div className="mt-4 flex h-[130px] items-end gap-2.5">
          {bars.map((h, i) => (
            <span key={i} className="flex-1 rounded-t-[4px] bg-[linear-gradient(#8C66FF,#4DD9FF)]" style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
    </>
  );
}
