"use client";

import { useEffect, useRef, useState } from "react";

import { posthog } from "@/lib/posthog";
import { downloadFor, onLinux } from "@/lib/platform";

/// Starts the dmg as the page opens, or the AppImage on x86_64 Linux. The file
/// is served as a download, so the browser keeps this page up. The ref holds
/// it to one start where React runs the effect twice in development.
export function StartDownload() {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    window.location.href = downloadFor(onLinux());
  }, []);
  return null;
}

/// The fallback link for the file that started, and the other platform's on
/// a line of its own. Read after mount, like the button that led here.
export function DownloadLinks({ className }: { className: string }) {
  const [linux, setLinux] = useState(false);
  useEffect(() => setLinux(onLinux()), []);

  return (
    <>
      <p className="mt-4 text-[16px] text-[#7C7C7C] light:text-[#8A8A8A]">
        The download starts on its own. If it didn&apos;t,{" "}
        <SupportLink href={downloadFor(linux)} to={linux ? "appimage" : "dmg"} className={className}>
          click here
        </SupportLink>
        .
      </p>
      <p className="mt-2 text-[16px] text-[#7C7C7C] light:text-[#8A8A8A]">
        {linux ? "On a Mac? " : "On Linux? "}
        <SupportLink href={downloadFor(!linux)} to={linux ? "dmg" : "appimage"} className={className}>
          {linux ? "Get the dmg" : "Get the AppImage (x86_64)"}
        </SupportLink>
        .
      </p>
    </>
  );
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
  to: "dmg" | "appimage";
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
