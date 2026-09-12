"use client";

import { posthog } from "@/lib/posthog";
import { AppleGlyph } from "@/components/AppleGlyph";
import { DOWNLOAD } from "@/lib/links";

/// The download link, split out as a client component so the click can be
/// counted. The href is a plain navigation off-site, so the event fires on the
/// way out — `sendBeacon` is what lets it survive the unload, where the default
/// transport is a request the browser is free to cancel as the page goes.
export function DownloadButton() {
  return (
    <a
      href={DOWNLOAD}
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
