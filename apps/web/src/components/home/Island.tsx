import type { ReactNode } from "react";
import { AppleGlyph } from "@/components/AppleGlyph";
import { IslandOrb } from "@/components/home/IslandOrb";
import { Flash, MessagesPanel, Play } from "@/components/home/IslandMotion";
import { Section, Title } from "@/components/home/Section";
import s from "@/components/home/island.module.css";

// A hand-drawn loop under the orb, overshooting its start.
const LOOP_PATH =
  "M362 296C350 268 318 256 285 257C238 258 194 280 193 312C192 344 236 365 282 364C330 363 370 344 368 314C367 302 360 292 348 284";

/// The island section: dictation, messages, waiting and done, questions and permissions, one card each.
export function Island() {
  return (
    <Section id="island" className="py-20">
      <Title lead="Talk to your sessions">from any app.</Title>
      <div className="mt-20 grid grid-cols-1 gap-[2px] lg:grid-cols-2">
        <Card label="Dictation" caption="Tap Control and talk, and your words land in the session. Hold Shift to circle what you mean, or drag out a screenshot.">
          <Scene>
            <IslandOrb size={120} lightBackdrop="#F4F4F5" className="absolute top-[130px] left-[179.5px]" />
            {/* ⇧ to draw: a loop, then a dragged region, one after the other. */}
            <svg width="479" height="480" viewBox="0 0 479 480" fill="none" className="absolute inset-0">
              <path
                d={LOOP_PATH}
                pathLength={1}
                stroke="#FF453A"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={s.ink}
              />
            </svg>
            {/* The island's pen tip while ⇧ is held. */}
            <div
              className={`absolute top-0 left-0 size-3 rounded-full border-2 border-white bg-[#FF453A] ${s.pen}`}
              style={{ offsetPath: `path("${LOOP_PATH}")` }}
            />
            <div className={`absolute top-[256px] left-[204px] ${s.region}`}>
              <Crosshair />
            </div>
          </Scene>
        </Card>

        <Card label="Messages" caption="Read a session's latest turns from whatever app you're in, and reply without switching.">
          <MessagesPanel />
        </Card>

        <Card
          label="Waiting and done"
          caption="When a session needs you or finishes, a pill hangs from the notch. Nothing opens until you want it to."
        >
          <div aria-hidden="true">
            <div className="absolute inset-x-0 top-0 flex h-[30px] items-center justify-between bg-[#FFFFFF0F] px-3.5 text-[12px] leading-4 text-[#FFFFFF99] light:bg-[#0000000A] light:text-[#000000A6]">
              <div className="flex items-center gap-4">
                <AppleGlyph className="h-[15px] w-[13px] shrink-0 text-[#FFFFFFCC] light:text-[#000000D9]" />
                <span className="max-sm:hidden">File</span>
                <span className="max-sm:hidden">Edit</span>
              </div>
              <span className="max-sm:hidden">Fri 30 Oct 7:14 PM</span>
            </div>
            <div className="absolute top-0 left-1/2 h-[66px] w-[244px] -translate-x-1/2">
              <div className={`absolute inset-0 ${s.pill}`}>
                <svg
                  width="244"
                  height="66"
                  viewBox="0 0 244 66"
                  className={`absolute inset-0 ${s.glow}`}
                  style={{ filter: "drop-shadow(0 0 14px #FFE14D59)" }}
                >
                  <path d="M0 0Q12 0 12 12L12 46Q12 66 32 66L212 66Q232 66 232 46L232 12Q232 0 244 0Z" fill="#000000" />
                </svg>
                <div className="absolute inset-x-0 top-[37px] flex items-center justify-center gap-2">
                  <div className="size-1.5 shrink-0 rounded-[3px] bg-[#FFE14D]" />
                  <div className="text-[13px] leading-4 font-semibold text-white">2 tasks need attention</div>
                </div>
              </div>
            </div>
            {/* The done pill, in place of Dray's banner: one session names itself and offers Open in app. */}
            <div className="absolute top-0 left-1/2 h-[70px] w-[320px] -translate-x-1/2">
              <div className={`absolute inset-0 ${s.donePill}`}>
                <svg
                  width="320"
                  height="70"
                  viewBox="0 0 320 70"
                  className={`absolute inset-0 ${s.doneGlow}`}
                  style={{ filter: "drop-shadow(0 0 14px #09BB8359)" }}
                >
                  <path d="M0 0Q12 0 12 12L12 50Q12 70 32 70L288 70Q308 70 308 50L308 12Q308 0 320 0Z" fill="#000000" />
                </svg>
                <div className="absolute inset-x-0 top-[37px] flex items-center justify-center gap-2 text-[13px] leading-4">
                  <div className="size-1.5 shrink-0 rounded-[3px] bg-[#09BB83]" />
                  <div className="font-semibold text-white">Done</div>
                  <div className="text-[#FFFFFF8C]">Retry uploads</div>
                  <div className="flex h-[22px] items-center rounded-[11px] bg-[#FFFFFF1F] px-2.5 text-[12px] font-medium text-white">
                    Open in app
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Card>

        <Card
          label="Questions and permissions"
          caption="Answer questions and approve tool calls at the notch or above the Dock, with number keys and Return."
        >
          <div
            aria-hidden="true"
            className={`absolute bottom-[132px] left-1/2 flex w-[400px] max-w-[calc(100%-32px)] -translate-x-1/2 origin-bottom flex-col gap-2.5 rounded-[20px] bg-black px-4 py-3.5 text-[13px] leading-[18px] shadow-[0_4px_12px_#00000059] ${s.ask}`}
          >
            <div className="flex items-center gap-1">
              <div className="flex h-[18px] items-center leading-4 font-semibold text-[#FFFFFF73]">Retry uploads</div>
              <div className="grow" />
              <div className="text-[12px] leading-4 text-[#FFFFFF4D]">Esc</div>
            </div>
            <div className="font-medium text-white">How should uploads retry?</div>
            <div className="flex flex-col gap-1.5">
              <Option n={1} className={`bg-[#FFFFFF33] ${s.pick1}`} hint="3 tries, waiting 1s, 2s, then 4s">
                Exponential backoff
              </Option>
              <Option n={2} className={`bg-[#FFFFFF14] ${s.pick2}`} hint="5 tries, 2s apart">
                Fixed interval
              </Option>
              <Option n={3} className="bg-[#FFFFFF14]">
                No retries
              </Option>
              <div className="flex h-8 shrink-0 items-center rounded-lg bg-[#FFFFFF14] px-2.5 text-[#FFFFFF4D]">
                Something else…
              </div>
            </div>
            <div className="flex items-center justify-end gap-3.5">
              <div className="text-[#FFFFFF80]">Skip</div>
              <div className={`flex h-7 items-center rounded-[14px] bg-white px-3 font-semibold whitespace-pre text-black ${s.press}`}>
                {"Send  ⏎"}
              </div>
            </div>
          </div>
          {/* The next card in line: a tool call held for approval. Options are the CLI's, Allow once first and Deny last. */}
          <div
            aria-hidden="true"
            className={`absolute bottom-[132px] left-1/2 flex w-[400px] max-w-[calc(100%-32px)] -translate-x-1/2 origin-bottom flex-col gap-2.5 rounded-[20px] bg-black px-4 py-3.5 text-[13px] leading-[18px] shadow-[0_4px_12px_#00000059] ${s.perm}`}
          >
            <div className="flex items-center gap-1">
              <div className="flex h-[18px] items-center leading-4 font-semibold text-[#FFFFFF73]">Retry uploads</div>
              <div className="grow" />
              <div className="text-[12px] leading-4 text-[#FFFFFF4D]">Esc</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="truncate">
                <span className="font-medium text-white">Bash</span>
                <span className="ml-1.5 text-[12px] text-[#FFFFFF80]">Run the upload client tests</span>
              </div>
              <div className="truncate font-mono text-[11px] leading-[14px] text-[#FFFFFF80]">pnpm test upload</div>
              {["Allow once", "Always allow Bash(pnpm test:*)", "Deny"].map((label, i) => (
                <div
                  key={label}
                  className={`flex h-[30px] shrink-0 items-center gap-2 rounded-lg bg-[#FFFFFF14] px-2.5 ${i === 0 ? s.allow : ""}`}
                >
                  <div className="w-2 shrink-0 text-[#FFFFFF4D]">{i + 1}</div>
                  <div className={`truncate ${label === "Deny" ? "text-[#FF453A]" : "text-white"}`}>{label}</div>
                </div>
              ))}
            </div>
          </div>
          <div aria-hidden="true">
            <Flash label="Allowed once" className={s.flash} />
          </div>
        </Card>
      </div>
    </Section>
  );
}

/// One 479×480 tile: art above, a mono label and a caption pinned to the foot.
function Card({ label, caption, children }: { label: string; caption: string; children: ReactNode }) {
  return (
    <Play className="relative h-[480px] overflow-clip bg-[#FFFFFF1A] light:bg-[#F4F4F5]">
      {children}
      <div className="absolute inset-x-6 bottom-6 flex flex-col gap-3">
        <h3 className="w-max font-mono text-[11px] leading-[14px] tracking-[0.06em] text-[#7C7C7C] uppercase">{label}</h3>
        <p className="max-w-[431px] text-[15px] leading-[22px] text-[#FFFFFFB3] light:text-[#3F3F46]">{caption}</p>
      </div>
    </Play>
  );
}

/// Paper's 479-wide coordinate box, centred, so art keeps its spot in a wider one-column card.
function Scene({ children }: { children: ReactNode }) {
  return (
    <div aria-hidden="true" className="absolute inset-y-0 left-1/2 w-[479px] -translate-x-1/2">
      {children}
    </div>
  );
}

/// macOS's region-select crosshair, riding the dragged corner.
function Crosshair() {
  return (
    <svg width="21" height="21" viewBox="0 0 21 21" className="absolute top-full left-full -translate-1/2">
      <path d="M10.5 1v19M1 10.5h19" stroke="#fff" strokeWidth="3" />
      <path d="M10.5 1v19M1 10.5h19" stroke="#000" strokeWidth="1" />
    </svg>
  );
}

/// One numbered answer row in the question card.
function Option({ n, hint, className, children }: { n: number; hint?: string; className: string; children: ReactNode }) {
  return (
    <div className={`flex gap-2 rounded-lg px-2.5 py-[7px] ${className}`}>
      <div className="w-2 shrink-0 text-[#FFFFFF4D]">{n}</div>
      <div className="flex flex-col gap-0.5">
        <div className="text-white">{children}</div>
        {hint && <div className="text-[11px] leading-[14px] text-[#FFFFFF66]">{hint}</div>}
      </div>
    </div>
  );
}
