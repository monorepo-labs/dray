"use client";

import { Server } from "lucide-react";
import { useRef, useState } from "react";

import { AndroidGlyph } from "@/components/AndroidGlyph";
import { AppleGlyph } from "@/components/AppleGlyph";
import { BetaTag } from "@/components/BetaTag";
import { LinuxFileLink } from "@/components/LinuxMenu";
import { LinuxGlyph } from "@/components/LinuxGlyph";
import { INSTALL_LINE } from "@/lib/links";
import { LINUX_FORMATS } from "@/lib/linux";

import { DmgLink } from "./client";
import { type DownloadTake } from "./styles";

const ARCHES = ["x64", "arm64"] as const;
const TEXT = "text-white light:text-[#0A0A0A]";
const MUTED = "text-[#8A8A8A] light:text-[#6B6B6B]";
const BETA = "text-[#A1A1A1] light:text-[#6B6B6B]";
/// A platform's own fill, and a second one a step off it for a Linux format.
const SURFACE = "bg-[#141414] light:bg-white";
const SURFACE_2 = "bg-[#1C1C1C] light:bg-[#FAFAF8]";
/// Every download is the site's blue, so the eye finds the actions first.
const BLUE = "group bg-[#1612F8] text-white transition-colors hover:bg-[#2D2AFF]";
const ON_BLUE = "text-white/70";
const ICON = `size-7 shrink-0 ${TEXT}`;

function DownArrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0 transition-transform group-hover:translate-y-0.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v10M3.5 8.5 8 13l4.5-4.5" />
    </svg>
  );
}

const SERVER_ICON = <Server className={ICON} strokeWidth={1.1} />;

/// A platform's mark, name and one line under, in the order the rows run.
function Platform({ icon, name, line, dim = false }: { icon: React.ReactNode; name: string; line: React.ReactNode; dim?: boolean }) {
  return (
    <div className={`flex items-center gap-4 ${dim ? "opacity-50" : ""}`}>
      {icon}
      <div className="min-w-0">
        <h2 className={`text-[22px] leading-7 tracking-[-0.02em] ${TEXT}`}>{name}</h2>
        <p className={`text-[14px] leading-5 ${MUTED}`}>{line}</p>
      </div>
    </div>
  );
}

const SERVER_LINE = (
  <>
    Linux or a headless Mac.{" "}
    <a href="/docs/server" className="underline decoration-current/40 underline-offset-4 hover:decoration-current">
      Setup guide
    </a>
  </>
);

/// The install line as one blue action that copies itself. The command keeps
/// a monospace face, the one place on the page that does: it is code.
function CopyAction({ className }: { className: string }) {
  const [copied, setCopied] = useState(false);
  const line = useRef<HTMLSpanElement>(null);
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(INSTALL_LINE).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => line.current && window.getSelection()?.selectAllChildren(line.current),
        )
      }
      className={`${BLUE} flex w-full cursor-pointer items-center justify-between gap-4 text-left ${className}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] leading-6 font-medium">Copy install command</span>
        <code ref={line} className={`block truncate font-mono text-[12.5px] leading-5 ${ON_BLUE}`}>
          {INSTALL_LINE}
        </code>
      </span>
      <span aria-live="polite" className="shrink-0 text-[14px] font-medium">
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}

function MacAction({ className }: { className: string }) {
  return (
    <DmgLink className={`${BLUE} flex items-center justify-between gap-4 ${className}`}>
      <span>
        <span className="block text-[16px] leading-6 font-medium">Download for macOS</span>
        <span className={`block text-[13px] leading-5 ${ON_BLUE}`}>Apple silicon and Intel, one .dmg</span>
      </span>
      <DownArrow />
    </DmgLink>
  );
}

function FormatLabel({ f }: { f: (typeof LINUX_FORMATS)[number] }) {
  return (
    <div>
      <p className={`flex items-center gap-2 text-[16px] leading-6 font-medium ${TEXT}`}>
        {f.name}
        <BetaTag plain className={BETA} />
      </p>
      <p className={`text-[13px] leading-5 ${MUTED}`}>{f.target}</p>
    </div>
  );
}

const SOON = [
  { name: "iPhone", icon: <AppleGlyph key="i" className={`${ICON} -mt-1`} /> },
  { name: "Android", icon: <AndroidGlyph key="a" className={ICON} /> },
];

/// Tiles: one boxed grid, every cell filled and 2px apart, so the page's own
/// background draws the lines. Each platform's right half is its blue cells.
function Tiles() {
  const row = "grid gap-[2px] sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]";
  const left = `${SURFACE} px-6 py-6`;
  return (
    <div className="grid gap-[2px] overflow-hidden rounded-[10px]">
      <div className={row}>
        <div className={left}>
          <Platform icon={<AppleGlyph className={`${ICON} -mt-1`} />} name="Mac" line="macOS 11 or later" />
        </div>
        <MacAction className="px-6 py-5" />
      </div>

      <div className={row}>
        <div className={`${left} flex items-center`}>
          <Platform icon={<LinuxGlyph className={ICON} />} name="Linux" line="x64 and arm64" />
        </div>
        <div className="grid gap-[2px]">
          {LINUX_FORMATS.map((f) => (
            <div key={f.id} className="grid grid-cols-[minmax(0,1fr)_96px_96px] gap-[2px]">
              <div className={`${SURFACE_2} px-6 py-4`}>
                <FormatLabel f={f} />
              </div>
              {ARCHES.map((arch) => (
                <LinuxFileLink
                  key={arch}
                  file={f.files[arch]}
                  format={f.id}
                  arch={arch}
                  from="downloads"
                  className={`${BLUE} flex items-center justify-center gap-2 text-[14px] font-medium`}
                >
                  {arch}
                  <DownArrow />
                </LinuxFileLink>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className={row}>
        <div className={left}>
          <Platform icon={SERVER_ICON} name="Server" line={SERVER_LINE} />
        </div>
        <CopyAction className="px-6 py-5" />
      </div>

      {SOON.map((p) => (
        <div key={p.name} className={row}>
          <div className={left}>
            <Platform icon={p.icon} name={p.name} line="Your sessions on your phone" dim />
          </div>
          <div className={`${SURFACE} flex items-center px-6 py-5 text-[14px] ${MUTED}`}>Coming soon</div>
        </div>
      ))}
    </div>
  );
}

/// Panels: each platform its own rounded, filled panel with space between,
/// its blue buttons rounded inside it.
function Panels() {
  const panel = `${SURFACE} grid items-center gap-5 rounded-[10px] p-5 sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] sm:p-6`;
  const button = "rounded-[8px]";
  return (
    <div className="flex flex-col gap-3">
      <section className={panel}>
        <Platform icon={<AppleGlyph className={`${ICON} -mt-1`} />} name="Mac" line="macOS 11 or later" />
        <MacAction className={`${button} px-5 py-4`} />
      </section>

      <section className={panel}>
        <Platform icon={<LinuxGlyph className={ICON} />} name="Linux" line="x64 and arm64" />
        <div className="flex flex-col gap-2">
          {LINUX_FORMATS.map((f) => (
            <div key={f.id} className={`${SURFACE_2} grid grid-cols-[minmax(0,1fr)_88px_88px] items-center gap-2 rounded-[8px] p-2 pl-4`}>
              <FormatLabel f={f} />
              {ARCHES.map((arch) => (
                <LinuxFileLink
                  key={arch}
                  file={f.files[arch]}
                  format={f.id}
                  arch={arch}
                  from="downloads"
                  className={`${BLUE} ${button} flex h-11 items-center justify-center gap-2 text-[14px] font-medium`}
                >
                  {arch}
                  <DownArrow />
                </LinuxFileLink>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className={panel}>
        <Platform icon={SERVER_ICON} name="Server" line={SERVER_LINE} />
        <CopyAction className={`${button} px-5 py-4`} />
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        {SOON.map((p) => (
          <section key={p.name} className={`${SURFACE} flex items-center justify-between gap-4 rounded-[10px] p-5 sm:p-6`}>
            <Platform icon={p.icon} name={p.name} line="Your sessions on your phone" dim />
            <span className={`shrink-0 rounded-full bg-white/[0.06] px-3 py-1 text-[13px] light:bg-black/[0.05] ${MUTED}`}>
              Coming soon
            </span>
          </section>
        ))}
      </div>
    </div>
  );
}

const TAKES: Record<DownloadTake, () => React.JSX.Element> = { tiles: Tiles, panels: Panels };

/// The downloads list, in whichever take is asked for.
export function DownloadTakeBody({ take }: { take: DownloadTake }) {
  const Body = TAKES[take];
  return <Body />;
}
