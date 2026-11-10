"use client";

import { useEffect, useState } from "react";
import { posthog } from "@/lib/posthog";
import { AppleGlyph } from "@/components/AppleGlyph";
import { onLinux } from "@/lib/platform";

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
///
/// An x86_64 Linux visitor is offered Linux, and `/download` starts the
/// AppImage for them. Read after mount, so the server render and the first
/// client one agree on the Mac's.
export function DownloadButton({
  className,
  label,
  from,
}: {
  className?: string;
  label?: string;
  from?: "nav" | "hero" | "cta";
}) {
  const [linux, setLinux] = useState(false);
  useEffect(() => setLinux(onLinux()), []);

  return (
    <a
      href="/download"
      onClick={() =>
        posthog.capture("download", { platform: linux ? "linux" : "macos", from }, { transport: "sendBeacon" })
      }
      className={className ?? "inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"}
    >
      {!linux && <AppleGlyph className="size-4" />}
      {label ?? (linux ? "Download for Linux" : "Download for macOS")}
    </a>
  );
}
