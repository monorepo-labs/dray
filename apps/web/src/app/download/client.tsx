"use client";

import { useEffect, useRef } from "react";

import { posthog } from "@/lib/posthog";
import { DOWNLOAD } from "@/lib/links";

/// Starts the dmg as the page opens. The file is served as a download, so the
/// browser keeps this page up. The ref holds it to one start where React runs
/// the effect twice in development.
export function StartDownload() {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    window.location.href = DOWNLOAD;
  }, []);
  return null;
}

/// An outbound link off the download page, counted by where it leads, so the
/// ask can be judged by how many readers act on it.
export function SupportLink({
  href,
  to,
  className,
  children,
}: {
  href: string;
  to: "dmg";
  className: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={() => posthog.capture("support_click", { to }, { transport: "sendBeacon" })}
      className={className}
    >
      {children}
    </a>
  );
}
