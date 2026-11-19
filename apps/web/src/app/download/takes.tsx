"use client";

import { useState } from "react";

import { AppleGlyph } from "@/components/AppleGlyph";
import { BetaTag } from "@/components/BetaTag";
import { LinuxFileLink } from "@/components/LinuxMenu";
import { CopyLine } from "@/components/home/Closing";
import { CARD_BODY, LABEL } from "@/components/home/Section";
import { LINUX_FORMATS, type LinuxFormat } from "@/lib/linux";

import { DmgLink } from "./client";
import { LINK, type DownloadTake } from "./styles";

const ARCHES = ["x64", "arm64"] as const;
const SURFACE = "bg-[#FFFFFF14] light:bg-white";
const KICKER = `${LABEL} text-[#A1A1A1] light:text-[#6B6B6B]`;
const TITLE = "flex items-center gap-3 text-[28px] leading-[32px] tracking-[-0.03em] text-white light:text-[#0A0A0A]";
const TEXT = "text-white light:text-[#0A0A0A]";
const MUTED = "text-[#8A8A8A] light:text-[#6B6B6B]";
const BETA = "text-[#A1A1A1] light:text-[#6B6B6B]";
const FILLED =
  "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-white px-4 text-[14px] leading-5 font-medium text-[#0B0B0F] shadow-[inset_0_-1px_0_#4D4C4C,0_1px_2px_#00000040] transition-opacity hover:opacity-90 [&>svg]:-mt-0.5 light:bg-[#0A0A0A] light:text-white light:shadow-[inset_0_-1px_0_#000,0_1px_2px_#00000040]";
const CHIP = `inline-flex h-9 items-center justify-center gap-1.5 rounded-[6px] border border-white/15 px-3.5 text-[13px] font-medium transition-colors hover:bg-white/10 light:border-black/15 light:hover:bg-black/5 ${TEXT}`;
const CODE =
  "rounded-[4px] bg-white/10 px-1.5 py-0.5 font-mono text-[12.5px] whitespace-nowrap text-white light:bg-black/[0.06] light:text-[#0A0A0A]";
const HINT = `text-[14px] leading-[22px] ${MUTED}`;

/// How to install each Linux format once it is down, in one line.
const HINTS: Record<LinuxFormat, React.ReactNode> = {
  deb: (
    <>
      Double-click it and press Install, or run <code className={CODE}>sudo apt install ./Dray_amd64.deb</code>.
      Ubuntu 22.04+ or Debian 12+.
    </>
  ),
  appimage: (
    <>
      Run <code className={CODE}>chmod +x Dray_amd64.AppImage</code>, then double-click it.
    </>
  ),
};

/// What is not out yet, drawn so the list reads as the whole plan.
const SOON = [
  { name: "iPhone", line: "Follow your sessions and answer them from your phone." },
  { name: "Android", line: "The same, on Android." },
];

function DownArrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v10M3.5 8.5 8 13l4.5-4.5" />
    </svg>
  );
}

function MacButton({ className = FILLED }: { className?: string }) {
  return (
    <DmgLink className={className}>
      <AppleGlyph className="size-4" />
      Download for macOS
    </DmgLink>
  );
}

/// One Linux format: its name with Beta, who it is for, and a button per arch.
function LinuxFormatBlock({ f, chip = false }: { f: (typeof LINUX_FORMATS)[number]; chip?: boolean }) {
  return (
    <>
      <div>
        <p className={`flex items-center gap-2 text-[16px] leading-6 font-medium ${TEXT}`}>
          {f.name}
          <BetaTag className={BETA} />
        </p>
        <p className={`text-[13px] leading-5 ${MUTED}`}>{f.target}</p>
      </div>
      <div className="flex gap-2">
        {ARCHES.map((arch) => (
          <LinuxFileLink key={arch} file={f.files[arch]} format={f.id} arch={arch} from="downloads" className={chip ? CHIP : FILLED}>
            <DownArrow />
            {arch}
          </LinuxFileLink>
        ))}
      </div>
    </>
  );
}

function ServerBlurb() {
  return (
    <p className={CARD_BODY}>
      Run your agents on another machine and drive them from the app.{" "}
      <a href="/docs/server" className={LINK}>
        Set up a server
      </a>
    </p>
  );
}

/// A: a card per platform in a grid; Linux's formats as cards inside its own,
/// the hero menu's shape.
function Cards() {
  return (
    <div className="grid gap-[2px] lg:grid-cols-2">
      <section className={`flex flex-col gap-8 p-6 sm:p-8 ${SURFACE}`}>
        <div className="flex flex-col gap-2">
          <p className={KICKER}>macOS 11 or later</p>
          <h2 className={TITLE}>Mac</h2>
          <p className={CARD_BODY}>One download for Apple silicon and Intel.</p>
        </div>
        <div className="flex flex-col gap-4">
          <MacButton className={`${FILLED} self-start`} />
          <p className={HINT}>Open the dmg and drag Dray into Applications.</p>
        </div>
      </section>

      <section className={`flex flex-col gap-6 p-6 sm:p-8 ${SURFACE}`}>
        <div className="flex flex-col gap-2">
          <p className={KICKER}>x64 and arm64</p>
          <h2 className={TITLE}>Linux</h2>
        </div>
        {LINUX_FORMATS.map((f) => (
          <div key={f.id} className="flex flex-col gap-3 rounded-[8px] bg-white/[0.05] p-4 light:bg-black/[0.03]">
            <LinuxFormatBlock f={f} chip />
            <p className={HINT}>{HINTS[f.id]}</p>
          </div>
        ))}
      </section>

      <section className={`flex flex-col gap-8 p-6 sm:p-8 lg:col-span-2 ${SURFACE}`}>
        <div className="flex flex-col gap-2">
          <p className={KICKER}>Linux or a headless Mac</p>
          <h2 className={TITLE}>Server</h2>
          <ServerBlurb />
        </div>
        <div className="max-w-[560px]">
          <CopyLine fill="bg-[#0B0B0F]" />
        </div>
      </section>

      {SOON.map((p) => (
        <section key={p.name} className={`flex flex-col gap-2 p-6 sm:p-8 ${SURFACE}`}>
          <p className={KICKER}>Coming soon</p>
          <h2 className={`${TITLE} text-white/50 light:text-black/40`}>{p.name}</h2>
          <p className={CARD_BODY}>{p.line}</p>
        </section>
      ))}
    </div>
  );
}

/// B: one full-width row per platform, name on the left and the actions on the
/// right, like an app store's list. No install hints.
function List() {
  const row = `grid gap-6 border-b border-white/10 py-8 last:border-b-0 sm:grid-cols-[240px_1fr] light:border-black/10`;
  return (
    <div className={`px-6 sm:px-8 ${SURFACE}`}>
      <div className={row}>
        <div>
          <h2 className={TITLE}>Mac</h2>
          <p className={`mt-1 ${KICKER}`}>macOS 11 or later</p>
        </div>
        <div className="flex flex-col gap-2 sm:items-start">
          <MacButton />
          <p className={`text-[13px] ${MUTED}`}>Apple silicon and Intel, one download.</p>
        </div>
      </div>
      <div className={row}>
        <div>
          <h2 className={TITLE}>Linux</h2>
          <p className={`mt-1 ${KICKER}`}>x64 and arm64</p>
        </div>
        <div className="flex flex-col gap-5">
          {LINUX_FORMATS.map((f) => (
            <div key={f.id} className="flex flex-wrap items-center justify-between gap-3">
              <LinuxFormatBlock f={f} chip />
            </div>
          ))}
        </div>
      </div>
      <div className={row}>
        <div>
          <h2 className={TITLE}>Server</h2>
          <p className={`mt-1 ${KICKER}`}>Linux or a headless Mac</p>
        </div>
        <div className="flex flex-col gap-3">
          <CopyLine fill="bg-[#0B0B0F]" />
          <ServerBlurb />
        </div>
      </div>
      {SOON.map((p) => (
        <div key={p.name} className={row}>
          <h2 className={`${TITLE} text-white/50 light:text-black/40`}>{p.name}</h2>
          <p className={`self-center ${KICKER}`}>Coming soon</p>
        </div>
      ))}
    </div>
  );
}

const TABS = ["Mac", "Linux", "Server", "iPhone", "Android"] as const;

/// C: a platform switch on top and one large panel for the pick.
function Tabs() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Mac");
  return (
    <div>
      <div role="tablist" className="flex flex-wrap gap-1 rounded-[8px] bg-white/[0.06] p-1 light:bg-black/[0.05] sm:inline-flex">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={t === tab}
            type="button"
            onClick={() => setTab(t)}
            className={`h-9 cursor-pointer rounded-[6px] px-4 text-[14px] font-medium transition-colors ${
              t === tab ? "bg-white text-[#0B0B0F] light:bg-[#0A0A0A] light:text-white" : `${MUTED} hover:text-white light:hover:text-[#0A0A0A]`
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel" className={`mt-3 min-h-[320px] p-6 sm:p-10 ${SURFACE}`}>
        {tab === "Mac" && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <p className={KICKER}>macOS 11 or later</p>
              <h2 className="text-[40px] leading-[44px] tracking-[-0.03em]">Dray for Mac</h2>
              <p className={CARD_BODY}>One download for Apple silicon and Intel.</p>
            </div>
            <MacButton className={`${FILLED} self-start`} />
            <p className={HINT}>Open the dmg and drag Dray into Applications.</p>
          </div>
        )}
        {tab === "Linux" && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <p className={KICKER}>x64 and arm64</p>
              <h2 className="text-[40px] leading-[44px] tracking-[-0.03em]">Dray for Linux</h2>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {LINUX_FORMATS.map((f) => (
                <div key={f.id} className="flex flex-col gap-3 rounded-[8px] bg-white/[0.05] p-4 light:bg-black/[0.03]">
                  <LinuxFormatBlock f={f} chip />
                  <p className={HINT}>{HINTS[f.id]}</p>
                </div>
              ))}
            </div>
          </div>
        )}
        {tab === "Server" && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <p className={KICKER}>Linux or a headless Mac</p>
              <h2 className="text-[40px] leading-[44px] tracking-[-0.03em]">Dray server</h2>
              <ServerBlurb />
            </div>
            <div className="max-w-[560px]">
              <CopyLine fill="bg-[#0B0B0F]" />
            </div>
          </div>
        )}
        {(tab === "iPhone" || tab === "Android") && (
          <div className="flex flex-col gap-2">
            <p className={KICKER}>Coming soon</p>
            <h2 className="text-[40px] leading-[44px] tracking-[-0.03em] text-white/50 light:text-black/40">Dray for {tab}</h2>
            <p className={CARD_BODY}>{SOON.find((s) => s.name === tab)?.line}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/// D: Mac and Linux as two tall equal cards, big type, buttons at the foot;
/// the server and what is coming on one line each beneath.
function Showcase() {
  const big = "text-[44px] leading-[48px] tracking-[-0.04em] text-white light:text-[#0A0A0A]";
  return (
    <div className="flex flex-col gap-[2px]">
      <div className="grid gap-[2px] lg:grid-cols-2">
        <section className={`flex min-h-[380px] flex-col justify-between gap-10 p-8 sm:p-10 ${SURFACE}`}>
          <div className="flex flex-col gap-3">
            <AppleGlyph className={`size-8 ${TEXT}`} />
            <h2 className={big}>Mac</h2>
            <p className={CARD_BODY}>macOS 11 or later. Apple silicon and Intel.</p>
          </div>
          <MacButton className={`${FILLED} h-12 self-start px-5 text-[15px]`} />
        </section>
        <section className={`flex min-h-[380px] flex-col justify-between gap-10 p-8 sm:p-10 ${SURFACE}`}>
          <div className="flex flex-col gap-3">
            <span className={`font-mono text-[28px] leading-8 ${TEXT}`}>$_</span>
            <h2 className={big}>Linux</h2>
            <p className={CARD_BODY}>x64 and arm64. Both kinds update themselves.</p>
          </div>
          <div className="flex flex-col gap-4">
            {LINUX_FORMATS.map((f) => (
              <div key={f.id} className="flex flex-wrap items-center justify-between gap-3">
                <LinuxFormatBlock f={f} chip />
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className={`flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8 ${SURFACE}`}>
        <div>
          <h2 className={`text-[20px] leading-7 ${TEXT}`}>Server</h2>
          <ServerBlurb />
        </div>
        <div className="w-full sm:max-w-[460px]">
          <CopyLine fill="bg-[#0B0B0F]" />
        </div>
      </section>
      <p className={`p-6 sm:px-8 ${SURFACE} ${KICKER}`}>Coming soon · iPhone · Android</p>
    </div>
  );
}

const TAKES: Record<DownloadTake, () => React.JSX.Element> = { A: Cards, B: List, C: Tabs, D: Showcase };

/// The downloads list, in whichever take is asked for.
export function DownloadTakeBody({ take }: { take: DownloadTake }) {
  const Body = TAKES[take];
  return <Body />;
}
