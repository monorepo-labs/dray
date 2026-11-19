"use client";

import { AppleGlyph } from "@/components/AppleGlyph";
import { BetaTag } from "@/components/BetaTag";
import { TESTFLIGHT } from "@/lib/links";
import { posthog } from "@/lib/posthog";

/// The iPhone app's TestFlight beta, beside the download buttons. Counted as
/// `testflight_click`, keyed by where it sits, since it leaves for Apple's page.
/// The closing band spells it out ("Download for iPhone" with a TestFlight
/// tag); the hero, three buttons wide, keeps it short.
export function IPhoneButton({ className, from }: { className: string; from: "hero" | "cta" }) {
  return (
    <a
      href={TESTFLIGHT}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => posthog.capture("testflight_click", { from }, { transport: "sendBeacon" })}
      className={className}
    >
      <AppleGlyph className="-mt-0.5 size-4" />
      {from === "cta" ? (
        <>
          Download for iPhone
          <BetaTag label="TestFlight" />
        </>
      ) : (
        "iPhone beta"
      )}
    </a>
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
