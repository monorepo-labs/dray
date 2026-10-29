"use client";

import { useEffect, useState } from "react";
import { posthog } from "@/lib/posthog";
import { AppleGlyph } from "@/components/AppleGlyph";
import { DOWNLOAD, DOWNLOAD_LINUX } from "@/lib/links";

/// The download link, split out as a client component so the click can be
/// counted.
///
/// **`sendBeacon` is kept even though the new tab means this page no longer
/// unloads.** It was load-bearing when the href navigated in place — the
/// default transport is a request the browser is free to cancel as the page
/// goes. It costs nothing now and it is what stops the event disappearing
/// silently if `target` is ever dropped again.
///
/// A Linux visitor gets the AppImage. Read after mount, so the server render
/// and the first client one agree on the Mac's.
export function DownloadButton({ className, label }: { className?: string; label?: string }) {
  const [linux, setLinux] = useState(false);
  useEffect(() => {
    const ua = navigator.userAgent;
    setLinux(/Linux/.test(ua) && !/Android/.test(ua));
  }, []);

  return (
    <a
      href={linux ? DOWNLOAD_LINUX : DOWNLOAD}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() =>
        posthog.capture("download", { platform: linux ? "linux" : "macos" }, { transport: "sendBeacon" })
      }
      className={className ?? "inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"}
    >
      {!linux && <AppleGlyph className="size-4" />}
      {label ?? (linux ? "Download for Linux" : "Download for macOS")}
    </a>
  );
}
