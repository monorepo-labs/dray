"use client";

import { useState } from "react";

import { AndroidGlyph } from "@/components/AndroidGlyph";
import { AppleGlyph } from "@/components/AppleGlyph";
import { BetaTag } from "@/components/BetaTag";
import { WindowsButton } from "@/components/DownloadButton";
import { LinuxMenu } from "@/components/LinuxMenu";
import { PhoneGlyph } from "@/components/PhoneGlyph";
import { ServerGlyph } from "@/components/ServerGlyph";
import { TuxMark } from "@/components/TuxMark";
import { WindowsGlyph } from "@/components/WindowsGlyph";
import { APP_STORE, FEEDBACK, INSTALL_LINE, SUPPORT_EMAIL, WINDOWS_MSI } from "@/lib/links";
import { posthog } from "@/lib/posthog";

import { DmgLink } from "./client";
import { LINK } from "./styles";

/// The hero's filled button, stretched to its card: white in dark, black in light.
const BUTTON =
  "flex h-10 w-full shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[6px] bg-white px-3.5 text-[14px] whitespace-nowrap leading-5 font-medium text-[#0B0B0F] shadow-[inset_0_-1px_0_#4D4C4C,0_1px_2px_#00000040,0_10px_28px_-10px_#00000099] transition-opacity hover:opacity-90 light:bg-[#0A0A0A] light:text-white light:shadow-[inset_0_-1px_0_#000,0_1px_2px_#00000040]";
const ART = "size-12 text-white light:text-[#0A0A0A]";

/// One platform: a striped panel with its mark, then name, a line and the one
/// thing to do. The stripes are the closing band's, 2px of light every 6px.
function Card({
  id,
  art,
  name,
  beta = false,
  line,
  children,
}: {
  id?: string;
  art: React.ReactNode;
  name: string;
  beta?: boolean;
  line: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col bg-white/10 light:bg-white">
      <div className="flex h-[180px] shrink-0 items-center justify-center bg-[repeating-linear-gradient(90deg,#FFFFFF0F_0_2px,transparent_2px_6px)] light:bg-[repeating-linear-gradient(90deg,#0000000A_0_2px,transparent_2px_6px)]">
        {art}
      </div>
      <div className="flex flex-1 flex-col justify-between gap-6 p-6">
        <div className="flex flex-col gap-1">
          <h2 className="flex items-center gap-2.5 text-[20px] leading-[26px] tracking-[-0.02em] text-white light:text-[#0A0A0A]">
            {name}
            {beta && <BetaTag className="text-[#A1A1A1] light:text-[#6B6B6B]" />}
          </h2>
          <p className="text-[15px] leading-[22px] text-[#8A8A8A] light:text-[#6B6B6B]">{line}</p>
        </div>
        {children}
      </div>
    </section>
  );
}

/// Copies the server install line, saying so for a moment once it has.
function CopyCommand() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(INSTALL_LINE).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      className={BUTTON}
    >
      <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M5 5h8v8H5zM3 10.5V3h7.5" />
      </svg>
      <span aria-live="polite">{copied ? "Copied" : "Copy command"}</span>
    </button>
  );
}

/// Every way to get Dray, one card each: the desktops, then the server and
/// the phones, three across on a wide screen.
export function DownloadCards() {
  return (
    <div className="grid gap-[2px] sm:grid-cols-2 lg:grid-cols-3">
      <Card art={<AppleGlyph className={`${ART} -mt-2`} />} name="macOS" line="Apple Silicon and Intel. macOS 11 or later.">
        <DmgLink className={`${BUTTON} [&>svg]:-mt-0.5`}>
          <AppleGlyph className="size-4" />
          Download for macOS
        </DmgLink>
      </Card>

      <Card
        art={<WindowsGlyph className={ART} />}
        name="Windows"
        beta
        line={
          <>
            x64. Windows 10 and 11. Also as an{" "}
            <a href={WINDOWS_MSI} className={LINK}>
              MSI
            </a>
            .
          </>
        }
      >
        <WindowsButton from="downloads" className={BUTTON} />
      </Card>

      <Card art={<TuxMark className={ART} />} name="Linux" beta line="x64 and arm64. Debian, Ubuntu and more.">
        <LinuxMenu from="downloads" icon={<TuxMark className="size-4" />} className={BUTTON} />
      </Card>

      <Card art={<ServerGlyph className={ART} />} name="Server" line="Copy the install command, run it over SSH.">
        <CopyCommand />
      </Card>

      <Card art={<PhoneGlyph className={ART} />} name="iPhone" line="iOS 17 or later.">
        <a
          href={APP_STORE}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => posthog.capture("app_store_click", { from: "downloads" }, { transport: "sendBeacon" })}
          className={BUTTON}
        >
          Download on the App Store
          <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M4.5 11.5l7-7M5.5 4.5h6v6" />
          </svg>
        </a>
      </Card>

      <Card
        id="android"
        art={<AndroidGlyph className={ART} />}
        name="Android"
        beta
        line="To get the beta, message Yogesh on X or email us."
      >
        <div className="grid grid-cols-2 gap-2">
          <a
            href={FEEDBACK}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => posthog.capture("android_beta_click", { to: "x" }, { transport: "sendBeacon" })}
            className={BUTTON}
          >
            Message on X
          </a>
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Android beta")}`}
            onClick={() => posthog.capture("android_beta_click", { to: "email" }, { transport: "sendBeacon" })}
            className={BUTTON}
          >
            Email us
          </a>
        </div>
      </Card>
    </div>
  );
}
