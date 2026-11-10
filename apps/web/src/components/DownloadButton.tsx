"use client";

import { posthog } from "@/lib/posthog";
import { AppleGlyph } from "@/components/AppleGlyph";

/// The download link, split out as a client component so the click can be
/// counted. It goes to `/download`, which starts the dmg itself and asks for
/// support while the file comes down. A plain anchor, not `Link`: from
/// `/download` itself a client navigation keeps the page mounted, and the
/// dmg would not start again.
///
/// The click is sent with `sendBeacon`, since it leaves the page and the
/// default transport is a request the browser is free to cancel as it goes.
///
/// `from` names the button's place on the page (`nav`, `hero`, `cta`), so
/// downloads can be split by where people clicked.
export function DownloadButton({
  className,
  label = "Download for macOS",
  from,
}: {
  className?: string;
  label?: string;
  from?: "nav" | "hero" | "cta";
}) {
  return (
    <a
      href="/download"
      onClick={() =>
        posthog.capture("download", { platform: "macos", from }, { transport: "sendBeacon" })
      }
      className={className ?? "inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"}
    >
      <AppleGlyph className="size-4" />
      {label}
    </a>
  );
}
