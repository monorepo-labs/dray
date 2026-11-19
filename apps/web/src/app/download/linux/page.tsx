import type { Metadata } from "next";

import { BetaTag } from "@/components/BetaTag";
import { Closing } from "@/components/home/Closing";
import { CARD_TITLE, LABEL } from "@/components/home/Section";
import { SiteNav } from "@/components/home/SiteNav";
import { Support } from "@/components/home/Support";
import { fetchStars } from "@/lib/github";
import { REPO } from "@/lib/links";
import { LINUX_FORMATS, availableLinuxFiles, linuxUrl, type LinuxFormat } from "@/lib/linux";

import { LinuxFileLink } from "../client";
import { H1, LEDE, LINK } from "../styles";

export const metadata: Metadata = {
  title: "Download for Linux - Dray",
  description: "Download the Dray beta for Linux: a .deb for Debian and Ubuntu, or an AppImage for any distro, on x64 and arm64.",
};

const RULE = "border-[#FFFFFF26] light:border-black/15";
const FILE_BUTTON =
  "inline-flex h-10 items-center gap-2 rounded-[6px] bg-white px-4 text-[14px] leading-5 font-medium text-[#0B0B0F] shadow-[inset_0_-1px_0_#4D4C4C,0_1px_2px_#00000040] transition-opacity hover:opacity-90 light:bg-[#0A0A0A] light:text-white light:shadow-[inset_0_-1px_0_#000,0_1px_2px_#00000040]";
const FILE_MISSING =
  "inline-flex h-10 cursor-default items-center gap-2 rounded-[6px] bg-white/[0.06] px-4 text-[14px] leading-5 font-medium text-white/40 light:bg-black/[0.05] light:text-black/35";
const CODE = "rounded-[4px] bg-white/10 px-1.5 py-0.5 font-mono whitespace-nowrap text-[12.5px] text-white light:bg-black/[0.06] light:text-[#0A0A0A]";

/// How to install each format once it is down, in one line.
const HINTS: Record<LinuxFormat, React.ReactNode> = {
  deb: (
    <>
      Double-click it and press Install, or run <code className={CODE}>sudo apt install ./Dray_amd64.deb</code>. Ubuntu
      22.04+ or Debian 12+.
    </>
  ),
  appimage: (
    <>
      Run <code className={CODE}>chmod +x Dray_amd64.AppImage</code>, then double-click it. Nothing else to install.
    </>
  ),
};

/// The Linux app's four files, two formats by two architectures. Nothing
/// starts on its own, unlike `/download`'s dmg: the visitor picks. A file R2
/// does not hold yet reads "Soon" instead of linking to a 404.
export default async function DownloadLinux() {
  const [stars, available] = await Promise.all([fetchStars(), availableLinuxFiles()]);

  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <header className="px-5 pb-[120px] sm:px-8 light:bg-[#F4F4F2]">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />
          <div className="lg:ml-[102px] lg:max-w-[756px]">
            <h1 className={`flex items-center gap-3 ${H1}`}>
              Dray for Linux
              <BetaTag className="h-5 px-1.5 text-[11px] text-[#A1A1A1] light:text-[#6B6B6B]" />
            </h1>
            <p className={`mt-4 ${LEDE}`}>
              Pick the file for your system. Both kinds update themselves from inside the app.
            </p>
            <p className={`mt-2 ${LEDE}`}>
              It&apos;s new on Linux, so if something breaks,{" "}
              <a href={`${REPO}/issues/new`} target="_blank" rel="noopener noreferrer" className={LINK}>
                tell us
              </a>
              .
            </p>
          </div>

          <section aria-label="Linux downloads" className={`mt-12 grid border lg:grid-cols-2 ${RULE}`}>
            {LINUX_FORMATS.map((f, i) => (
              <div
                key={f.id}
                className={`flex flex-col gap-6 p-6 sm:p-8 ${i === 0 ? `border-b lg:border-r lg:border-b-0 ${RULE}` : ""}`}
              >
                <div className="flex flex-col gap-1.5">
                  <p className={`${LABEL} text-[#A1A1A1] light:text-[#6B6B6B]`}>{f.target}</p>
                  <h2 className={CARD_TITLE}>{f.name}</h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(["x64", "arm64"] as const).map((arch) => {
                    const file = f.files[arch];
                    return available.has(file) ? (
                      <LinuxFileLink key={arch} href={linuxUrl(file)} format={f.id} arch={arch} className={FILE_BUTTON}>
                        <DownArrow />
                        {arch}
                      </LinuxFileLink>
                    ) : (
                      <span key={arch} aria-disabled="true" className={FILE_MISSING}>
                        {arch}
                        <span className={`${LABEL} text-[10px]`}>Soon</span>
                      </span>
                    );
                  })}
                </div>
                <p className="text-[14px] leading-[22px] text-[#8A8A8A] light:text-[#6B6B6B]">{HINTS[f.id]}</p>
              </div>
            ))}
          </section>

          <div className="mt-12">
            <Support from="download" stars={stars} />
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
