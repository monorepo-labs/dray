"use client";

import { AppleGlyph } from "@/components/AppleGlyph";
import { BetaTag } from "@/components/BetaTag";
import { WindowsGlyph } from "@/components/WindowsGlyph";
import { APP_STORE, WINDOWS_DOWNLOAD } from "@/lib/links";
import { posthog } from "@/lib/posthog";

/// The Windows installer, straight to the file the way Linux's are: no thanks
/// page, so the click is the download. `beta` is the tag's class, for a
/// button whose card does not carry one already.
export function WindowsButton({
  className,
  from,
  beta,
}: {
  className: string;
  from: "hero" | "cta" | "downloads";
  beta?: string;
}) {
  return (
    <a
      href={WINDOWS_DOWNLOAD}
      onClick={() => posthog.capture("download", { platform: "windows", from }, { transport: "sendBeacon" })}
      className={className}
    >
      <WindowsGlyph className="size-3.5" />
      Download for Windows
      {beta !== undefined && <BetaTag className={beta} />}
    </a>
  );
}

/// The hero's line under its buttons, pointing at the phone apps: the App
/// Store, and the Android beta's card on `/download`.
export function PhonesLine({ className }: { className: string }) {
  const link = "text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white light:text-[#0A0A0A] light:decoration-black/30 light:hover:decoration-black";
  return (
    <p className={className}>
      Also on{" "}
      <a
        href={APP_STORE}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => posthog.capture("app_store_click", { from: "hero" }, { transport: "sendBeacon" })}
        className={link}
      >
        iPhone
      </a>{" "}
      and{" "}
      <a href="/download#android" className={link}>
        Android
      </a>{" "}
      (beta).
    </p>
  );
}

/// The Mac download link, split out as a client component so the click can
/// be counted. It goes to `/thank-you`, which starts the dmg itself and
/// asks for support while the file comes down. A plain anchor, not `Link`:
/// from that page itself a client navigation keeps the page mounted, and the
/// dmg would not start again.
///
/// The click is sent with `sendBeacon`, since it leaves the page and the
/// default transport is a request the browser is free to cancel as it goes.
///
/// `from` names the button's place on the page (`hero`, `cta`, `downloads`),
/// so downloads can be split by where people clicked.
export function DownloadButton({
  className,
  label = "Download for macOS",
  from,
}: {
  className?: string;
  label?: string;
  from?: "hero" | "cta" | "downloads";
}) {
  return (
    <a
      href="/thank-you"
      onClick={() => posthog.capture("download", { platform: "macos", from }, { transport: "sendBeacon" })}
      className={className ?? "inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"}
    >
      <AppleGlyph className="size-4" />
      {label}
    </a>
  );
}
