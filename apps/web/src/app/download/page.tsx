import type { Metadata } from "next";

import { AppleGlyph } from "@/components/AppleGlyph";
import { BetaTag } from "@/components/BetaTag";
import { LinuxFileLink } from "@/components/LinuxMenu";
import { Closing, CopyLine } from "@/components/home/Closing";
import { CARD_BODY, CARD_TITLE, LABEL } from "@/components/home/Section";
import { SiteNav } from "@/components/home/SiteNav";
import { LINUX_FORMATS, availableLinuxFiles, type LinuxFormat } from "@/lib/linux";

import { DmgLink } from "./client";
import { H1, LEDE, LINK } from "./styles";

export const metadata: Metadata = {
  title: "Download - Dray",
  description:
    "Download Dray for macOS or Linux (beta), or install it on a server. Free and open source.",
};

const SURFACE = "bg-[#FFFFFF14] p-6 sm:p-8 light:bg-white";
const CARD = `flex flex-col gap-8 ${SURFACE}`;
const KICKER = `${LABEL} text-[#A1A1A1] light:text-[#6B6B6B]`;
const BIG_TITLE = "flex items-center gap-3 text-[28px] leading-[32px] tracking-[-0.03em] text-white light:text-[#0A0A0A]";
const FILLED =
  "inline-flex h-10 items-center gap-2 rounded-[6px] bg-white px-4 text-[14px] leading-5 font-medium text-[#0B0B0F] shadow-[inset_0_-1px_0_#4D4C4C,0_1px_2px_#00000040] transition-opacity hover:opacity-90 light:bg-[#0A0A0A] light:text-white light:shadow-[inset_0_-1px_0_#000,0_1px_2px_#00000040]";
const MISSING =
  "inline-flex h-10 cursor-default items-center gap-2 rounded-[6px] bg-white/[0.06] px-4 text-[14px] leading-5 font-medium text-white/40 light:bg-black/[0.05] light:text-black/35";
const CODE =
  "rounded-[4px] bg-white/10 px-1.5 py-0.5 font-mono text-[12.5px] whitespace-nowrap text-white light:bg-black/[0.06] light:text-[#0A0A0A]";
const HINT = "text-[14px] leading-[22px] text-[#8A8A8A] light:text-[#6B6B6B]";

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

/// Every way to get Dray, one card per platform, and nothing else: no ask,
/// no auto-start. The Download for macOS buttons elsewhere go by way of
/// `/download/thanks`, which starts the dmg and asks for support.
export default async function Downloads() {
  const available = await availableLinuxFiles();

  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <header className="px-5 pb-[120px] sm:px-8 light:bg-[#F4F4F2]">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />
          <div className="lg:ml-[102px] lg:max-w-[756px]">
            <h1 className={H1}>Download Dray</h1>
            <p className={`mt-4 ${LEDE}`}>Free and open source, on your computer or your servers.</p>
          </div>

          <div className="mt-12 grid gap-[2px] lg:grid-cols-2">
            <section aria-labelledby="mac" className={CARD}>
              <div className="flex flex-col gap-2">
                <p className={KICKER}>macOS 11 or later</p>
                <h2 id="mac" className={BIG_TITLE}>
                  Mac
                </h2>
                <p className={CARD_BODY}>One download for Apple silicon and Intel.</p>
              </div>
              <div className="flex flex-col gap-4">
                <DmgLink className={`${FILLED} self-start [&>svg]:-mt-0.5`}>
                  <AppleGlyph className="size-4" />
                  Download for macOS
                </DmgLink>
                <p className={HINT}>Open the dmg and drag Dray into Applications.</p>
              </div>
            </section>

            <section aria-labelledby="linux" className={CARD}>
              <div className="flex flex-col gap-2">
                <p className={KICKER}>x64 and arm64</p>
                <h2 id="linux" className={BIG_TITLE}>
                  Linux
                  <BetaTag className="h-5 px-1.5 text-[11px] text-[#A1A1A1] light:text-[#6B6B6B]" />
                </h2>
                <p className={CARD_BODY}>New on Linux. Both kinds update themselves from inside the app.</p>
              </div>
              {LINUX_FORMATS.map((f) => (
                <div key={f.id} className="flex flex-col gap-3">
                  <p className="text-[15px] leading-[22px] text-white light:text-[#0A0A0A]">
                    {f.name} <span className="text-[#8A8A8A] light:text-[#6B6B6B]">· {f.target}</span>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(["x64", "arm64"] as const).map((arch) => {
                      const file = f.files[arch];
                      return available.includes(file) ? (
                        <LinuxFileLink key={arch} file={file} format={f.id} arch={arch} from="downloads" className={FILLED}>
                          <DownArrow />
                          {arch}
                        </LinuxFileLink>
                      ) : (
                        <span key={arch} aria-disabled="true" className={MISSING}>
                          {arch}
                          <span className={`${LABEL} text-[10px]`}>Soon</span>
                        </span>
                      );
                    })}
                  </div>
                  <p className={HINT}>{HINTS[f.id]}</p>
                </div>
              ))}
            </section>

            <section aria-labelledby="server" className={`${CARD} lg:col-span-2`}>
              <div className="flex flex-col gap-2">
                <p className={KICKER}>Linux or a headless Mac</p>
                <h2 id="server" className={BIG_TITLE}>
                  Server
                </h2>
                <p className={CARD_BODY}>
                  Run your agents on another machine and drive them from the app.{" "}
                  <a href="/docs/server" className={LINK}>
                    Set up a server
                  </a>
                </p>
              </div>
              <div className="max-w-[560px]">
                <CopyLine fill="bg-[#0B0B0F]" />
              </div>
            </section>

            {SOON.map((p) => (
              <section key={p.name} aria-label={`${p.name}, coming soon`} className={`flex flex-col gap-2 ${SURFACE}`}>
                <p className={KICKER}>Coming soon</p>
                <h2 className={`${BIG_TITLE} text-white/50 light:text-black/40`}>{p.name}</h2>
                <p className={CARD_BODY}>{p.line}</p>
              </section>
            ))}
          </div>
        </div>
      </header>

      <Closing />
    </div>
  );
}

function DownArrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v10M3.5 8.5 8 13l4.5-4.5" />
    </svg>
  );
}
