"use client";

import { posthog } from "@/lib/posthog";
import { AppleGlyph } from "@/components/AppleGlyph";
import { DOWNLOAD } from "@/lib/links";

/// The download link, split out as a client component so the click can be
/// counted.
///
/// **`sendBeacon` is kept even though the new tab means this page no longer
/// unloads.** It was load-bearing when the href navigated in place — the
/// default transport is a request the browser is free to cancel as the page
/// goes. It costs nothing now and it is what stops the event disappearing
/// silently if `target` is ever dropped again.
export function DownloadButton() {
  return (
    <a
      href={DOWNLOAD}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() =>
        posthog.capture("download", { platform: "macos" }, { transport: "sendBeacon" })
      }
      className="inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
    >
      <AppleGlyph className="size-4" />
      Download for macOS
    </a>
  );
}
