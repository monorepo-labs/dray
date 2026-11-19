"use client";

import { useRef, useState } from "react";

import { AndroidGlyph } from "@/components/AndroidGlyph";
import { AppleGlyph } from "@/components/AppleGlyph";
import { BetaTag } from "@/components/BetaTag";
import { LinuxFileLink } from "@/components/LinuxMenu";
import { LinuxGlyph } from "@/components/LinuxGlyph";
import { ServerGlyph } from "@/components/ServerGlyph";
import { INSTALL_LINE } from "@/lib/links";
import { LINUX_FORMATS } from "@/lib/linux";

import { DmgLink } from "./client";

const ARCHES = ["x64", "arm64"] as const;
const TEXT = "text-white light:text-[#0A0A0A]";
const MUTED = "text-[#8A8A8A] light:text-[#6B6B6B]";
const SURFACE = "bg-[#141414] light:bg-white";
/// Every download is filled like the hero's button, white in dark and black in
/// light, under the closing band's stripes (1px every 6px), so the eye finds
/// the actions first.
const FILLED =
  "group bg-white bg-[repeating-linear-gradient(90deg,#0000000F_0_1px,transparent_1px_6px)] text-[#0B0B0F] transition-colors hover:bg-[#E6E6E6] light:bg-[#0A0A0A] light:bg-[repeating-linear-gradient(90deg,#FFFFFF1A_0_1px,transparent_1px_6px)] light:text-white light:hover:bg-[#262626]";
const ICON = `size-7 shrink-0 ${TEXT}`;

function DownArrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0 transition-transform group-hover:translate-y-0.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v10M3.5 8.5 8 13l4.5-4.5" />
    </svg>
  );
}

/// A platform's mark, name and one line under.
function Platform({
  icon,
  name,
  line,
  beta = false,
  dim = false,
}: {
  icon: React.ReactNode;
  name: string;
  line: React.ReactNode;
  beta?: boolean;
  dim?: boolean;
}) {
  return (
    <div className={`flex items-center gap-4 ${dim ? "opacity-50" : ""}`}>
      {icon}
      <div className="min-w-0">
        <h2 className={`flex items-center gap-2.5 text-[22px] leading-7 tracking-[-0.02em] ${TEXT}`}>
          {name}
          {beta && <BetaTag plain className="text-[#A1A1A1] light:text-[#6B6B6B]" />}
        </h2>
        <p className={`text-[14px] leading-5 ${MUTED}`}>{line}</p>
      </div>
    </div>
  );
}

/// The install line itself as a blue cell that copies it. The command keeps
/// a monospace face, the one place on the page that does: it is code.
function CopyCommand() {
  const [copied, setCopied] = useState(false);
  const line = useRef<HTMLElement>(null);
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
      className={`${FILLED} flex w-full cursor-pointer items-center justify-between gap-4 px-6 py-5 text-left`}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-[14px] leading-6">
        <span className="text-black/40 select-none light:text-white/50">$ </span>
        <span ref={line}>{INSTALL_LINE}</span>
      </code>
      <span aria-live="polite" className="shrink-0 text-[14px] font-medium">
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}

const SOON = [
  { name: "iPhone", icon: <AppleGlyph className={`${ICON} -mt-1`} /> },
  { name: "Android", icon: <AndroidGlyph className={ICON} /> },
];

/// One boxed grid of filled, square cells 2px apart, so the page's own
/// background draws the lines. Each platform's right half is its blue cells.
export function DownloadGrid() {
  const row = "grid gap-[2px] sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]";
  const left = `${SURFACE} flex items-center px-6 py-6`;
  return (
    <div className="grid gap-[2px]">
      <div className={row}>
        <div className={left}>
          <Platform icon={<AppleGlyph className={`${ICON} -mt-1`} />} name="Mac" line="macOS 11 or later" />
        </div>
        <DmgLink className={`${FILLED} flex items-center justify-between gap-4 px-6 py-5`}>
          <span>
            <span className="block text-[16px] leading-6 font-medium">Download for macOS</span>
            <span className="block text-[13px] leading-5 text-black/55 light:text-white/65">Apple silicon and Intel, one .dmg</span>
          </span>
          <DownArrow />
        </DmgLink>
      </div>

      <div className={row}>
        <div className={left}>
          <Platform icon={<LinuxGlyph className={ICON} />} name="Linux" line="x64 and arm64" beta />
        </div>
        <div className="grid gap-[2px]">
          {LINUX_FORMATS.map((f) => (
            <div key={f.id} className="grid grid-cols-[minmax(0,1fr)_96px_96px] gap-[2px]">
              <div className={`${SURFACE} px-6 py-4`}>
                <p className={`text-[16px] leading-6 font-medium ${TEXT}`}>{f.name}</p>
                <p className={`text-[13px] leading-5 ${MUTED}`}>{f.target}</p>
              </div>
              {ARCHES.map((arch) => (
                <LinuxFileLink
                  key={arch}
                  file={f.files[arch]}
                  format={f.id}
                  arch={arch}
                  from="downloads"
                  className={`${FILLED} flex items-center justify-center gap-2 text-[14px] font-medium`}
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
          <Platform
            icon={<ServerGlyph className={ICON} />}
            name="Server"
            line={
              <>
                Linux or a headless Mac.{" "}
                <a href="/docs/server" className="underline decoration-current/40 underline-offset-4 hover:decoration-current">
                  Setup guide
                </a>
              </>
            }
          />
        </div>
        <CopyCommand />
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
