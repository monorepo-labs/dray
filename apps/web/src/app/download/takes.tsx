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
const LINE = "border-white/15 light:border-black/10";
const TEXT = "text-white light:text-[#0A0A0A]";
const MUTED = "text-[#8A8A8A] light:text-[#6B6B6B]";
const BETA = "text-[#A1A1A1] light:text-[#6B6B6B]";
/// A whole cell that is the download: fills its slot, tints on hover.
const CELL = `group flex items-center justify-between gap-4 px-6 py-5 transition-colors hover:bg-white/[0.06] light:hover:bg-black/[0.04] ${TEXT}`;
const ICON = `size-7 shrink-0 ${TEXT}`;

function DownArrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0 opacity-60 transition-transform group-hover:translate-y-0.5 group-hover:opacity-100" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v10M3.5 8.5 8 13l4.5-4.5" />
    </svg>
  );
}

/// The left half of a row: the platform's mark, its name and one line under.
function Platform({ icon, name, line, dim = false }: { icon: React.ReactNode; name: string; line: React.ReactNode; dim?: boolean }) {
  return (
    <div className={`flex items-center gap-4 px-6 py-6 ${dim ? "opacity-50" : ""}`}>
      {icon}
      <div className="min-w-0">
        <h2 className={`text-[22px] leading-7 tracking-[-0.02em] ${TEXT}`}>{name}</h2>
        <p className={`text-[14px] leading-5 ${MUTED}`}>{line}</p>
      </div>
    </div>
  );
}

/// The install line as one cell that copies itself. The command keeps a
/// monospace face, the one place on the page that does: it is code to paste.
function CopyCell({ className = "" }: { className?: string }) {
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
      className={`${CELL} w-full cursor-pointer text-left ${className}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] leading-6 font-medium">Copy install command</span>
        <code ref={line} className={`block truncate font-mono text-[12.5px] leading-5 ${MUTED}`}>
          {INSTALL_LINE}
        </code>
      </span>
      <span aria-live="polite" className={`shrink-0 text-[14px] ${MUTED}`}>
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}

/// One take on the list. `bleed` runs every divider the window's full width;
/// without it the list sits in a box whose edges the dividers meet.
function Rows({ bleed }: { bleed: boolean }) {
  const row = `grid border-t sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] ${LINE}`;
  const right = `border-t sm:border-t-0 sm:border-l ${LINE}`;
  const wrap = (children: React.ReactNode, key: string) =>
    bleed ? (
      <div key={key} className={`border-t ${LINE}`}>
        <div className={`mx-auto grid max-w-[960px] sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] sm:border-x ${LINE}`}>{children}</div>
      </div>
    ) : (
      <div key={key} className={row}>
        {children}
      </div>
    );

  const rows = [
    wrap(
      <>
        <Platform icon={<AppleGlyph className={`${ICON} -mt-1`} />} name="Mac" line="macOS 11 or later" />
        <div className={`${right} flex`}>
          <DmgLink className={`${CELL} flex-1`}>
            <span>
              <span className="block text-[16px] leading-6 font-medium">Download for macOS</span>
              <span className={`block text-[13px] leading-5 ${MUTED}`}>Apple silicon and Intel, one .dmg</span>
            </span>
            <DownArrow />
          </DmgLink>
        </div>
      </>,
      "mac",
    ),
    wrap(
      <>
        <Platform icon={<LinuxGlyph className={ICON} />} name="Linux" line="x64 and arm64" />
        <div className={right}>
          {LINUX_FORMATS.map((f, i) => (
            <div key={f.id} className={`grid grid-cols-[minmax(0,1fr)_96px_96px] ${i > 0 ? `border-t ${LINE}` : ""}`}>
              <div className="px-6 py-4">
                <p className={`flex items-center gap-2 text-[16px] leading-6 font-medium ${TEXT}`}>
                  {f.name}
                  <BetaTag plain className={BETA} />
                </p>
                <p className={`text-[13px] leading-5 ${MUTED}`}>{f.target}</p>
              </div>
              {ARCHES.map((arch) => (
                <LinuxFileLink
                  key={arch}
                  file={f.files[arch]}
                  format={f.id}
                  arch={arch}
                  from="downloads"
                  className={`${CELL} justify-center gap-2 border-l px-0 text-[14px] font-medium ${LINE}`}
                >
                  {arch}
                  <DownArrow />
                </LinuxFileLink>
              ))}
            </div>
          ))}
        </div>
      </>,
      "linux",
    ),
    wrap(
      <>
        <Platform
          icon={<Server className={ICON} strokeWidth={1.75} />}
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
        {bleed ? (
          <div className={`${right} grid grid-cols-[minmax(0,1fr)_auto]`}>
            <CopyCell />
            <a href="/docs/server" className={`${CELL} border-l text-[14px] font-medium ${LINE}`}>
              Guide
              <span aria-hidden>→</span>
            </a>
          </div>
        ) : (
          <div className={`${right} flex`}>
            <CopyCell />
          </div>
        )}
      </>,
      "server",
    ),
    ...(
      [
        ["iPhone", <AppleGlyph key="i" className={`${ICON} -mt-1`} />],
        ["Android", <AndroidGlyph key="a" className={ICON} />],
      ] as const
    ).map(([name, icon]) =>
      wrap(
        <>
          <Platform icon={icon} name={name} line="Your sessions on your phone" dim />
          <div className={`${right} flex items-center px-6 py-5 text-[14px] ${MUTED}`}>Coming soon</div>
        </>,
        name,
      ),
    ),
  ];

  return bleed ? (
    <div className={`relative left-1/2 w-screen -translate-x-1/2 border-b ${LINE}`}>{rows}</div>
  ) : (
    <div className={`border-x border-b ${LINE}`}>{rows}</div>
  );
}

const TAKES: Record<DownloadTake, () => React.JSX.Element> = {
  boxed: () => <Rows bleed={false} />,
  bleed: () => <Rows bleed />,
};

/// The downloads list, in whichever take is asked for.
export function DownloadTakeBody({ take }: { take: DownloadTake }) {
  const Body = TAKES[take];
  return <Body />;
}
