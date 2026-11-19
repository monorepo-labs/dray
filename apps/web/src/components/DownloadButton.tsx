"use client";

import { useEffect, useState } from "react";

import { AppleGlyph } from "@/components/AppleGlyph";
import { BetaTag } from "@/components/BetaTag";
import { LINUX_PAGE } from "@/lib/links";
import { onLinux } from "@/lib/platform";
import { posthog } from "@/lib/posthog";

/// Whether this visitor is on Linux, read after mount so the server render and
/// the first client one agree on the Mac's.
function useOnLinux(): boolean {
  const [linux, setLinux] = useState(false);
  useEffect(() => setLinux(onLinux()), []);
  return linux;
}

/// The download link, split out as a client component so the click can be
/// counted. It goes to `/download`, which starts the dmg itself and asks for
/// support while the file comes down. A plain anchor, not `Link`: from
/// `/download` itself a client navigation keeps the page mounted, and the
/// dmg would not start again.
///
/// A Linux visitor is offered Linux instead, and sent to the page listing its
/// files, since there are four and a browser cannot pick between them.
///
/// The click is sent with `sendBeacon`, since it leaves the page and the
/// default transport is a request the browser is free to cancel as it goes.
///
/// `from` names the button's place on the page (`nav`, `hero`, `cta`), so
/// downloads can be split by where people clicked.
export function DownloadButton({
  className,
  label,
  from,
}: {
  className?: string;
  label?: string;
  from?: "nav" | "hero" | "cta";
}) {
  const linux = useOnLinux();

  return (
    <a
      href={linux ? LINUX_PAGE : "/download"}
      onClick={() =>
        posthog.capture("download", { platform: linux ? "linux" : "macos", from }, { transport: "sendBeacon" })
      }
      className={className ?? "inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"}
    >
      {!linux && <AppleGlyph className="size-4" />}
      {label ?? (linux ? "Download for Linux" : "Download for macOS")}
      {linux && !label && <BetaTag />}
    </a>
  );
}

/// The quiet link beside a download button to the platform it does not offer:
/// Linux for everyone else, macOS for a Linux visitor.
export function OtherPlatformLink({ className }: { className: string }) {
  const linux = useOnLinux();

  return linux ? (
    <a href="/download" className={className}>
      Also on macOS
    </a>
  ) : (
    <a href={LINUX_PAGE} className={className}>
      Also on Linux
      <BetaTag />
    </a>
  );
}
