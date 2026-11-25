"use client";

import { useEffect, useState } from "react";

import { AndroidGlyph } from "@/components/AndroidGlyph";
import { AppleGlyph } from "@/components/AppleGlyph";
import { APP_STORE } from "@/lib/links";
import { posthog } from "@/lib/posthog";

const FILLED =
  "inline-flex h-10 items-center gap-2 rounded-[6px] bg-white px-4 text-[14px] leading-5 font-medium text-[#0B0B0F] shadow-[inset_0_-1px_0_#4D4C4C,0_1px_2px_#00000040,0_10px_28px_-10px_#00000099] transition-opacity hover:opacity-90 light:bg-[#0A0A0A] light:text-white light:shadow-[inset_0_-1px_0_#000,0_1px_2px_#00000040]";
const OUTLINE =
  "inline-flex h-10 items-center gap-2 rounded-[6px] border border-white/20 px-4 text-[14px] leading-5 font-medium text-white transition-colors hover:bg-white/10 light:border-black/15 light:text-[#0A0A0A] light:hover:bg-black/5";
const LINK =
  "text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white light:text-[#0A0A0A] light:decoration-black/30 light:hover:decoration-black";

type Phone = "ios" | "android" | "other";

/// Which phone this is, off the user agent. iPadOS asks for desktop pages as a
/// Mac, so a Mac with a touch screen counts as one.
function phone(): Phone {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  return "other";
}

/// The hero's buttons on a phone: the app for this phone's OS, both where it
/// can't tell, and a line pointing at the desktop apps. Renders both until it
/// has read the user agent, so the server's HTML never guesses wrong.
export function PhoneDownloads({ className = "" }: { className?: string }) {
  const [os, setOs] = useState<Phone>("other");
  useEffect(() => setOs(phone()), []);

  return (
    <div className={className}>
      <div className="mt-8 flex flex-col gap-3">
        {os !== "android" && (
          <a
            href={APP_STORE}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => posthog.capture("app_store_click", { from: "hero" }, { transport: "sendBeacon" })}
            className={`${FILLED} w-full justify-center`}
          >
            <AppleGlyph className="-mt-0.5 size-4" />
            Download for iPhone
          </a>
        )}
        {os !== "ios" && (
          <a href="/download#android" className={`${os === "android" ? FILLED : OUTLINE} w-full justify-center`}>
            <AndroidGlyph className="size-4" />
            Get the Android beta
          </a>
        )}
      </div>
      <p className="mt-4 text-[14px] leading-5 tracking-[-0.01em] text-white/50 light:text-black/50">
        Also on Mac, Windows and Linux.{" "}
        <a href="/download" className={LINK}>
          All downloads
        </a>
      </p>
    </div>
  );
}
