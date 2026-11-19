"use client";

import { useEffect, useRef, useState } from "react";

import { LINUX_FORMATS, linuxUrl, type LinuxArch, type LinuxFormat } from "@/lib/linux";
import { posthog } from "@/lib/posthog";

/// A link to one Linux file, counted by format and arch so the site can tell
/// which of the four are wanted. Nothing starts a Linux file on its own, so
/// this click is the download.
export function LinuxFileLink({
  file,
  format,
  arch,
  from,
  className,
  children,
}: {
  file: string;
  format: LinuxFormat;
  arch: LinuxArch;
  from: "hero" | "downloads";
  className: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={linuxUrl(file)}
      onClick={() => posthog.capture("linux_download", { format, arch, from }, { transport: "sendBeacon" })}
      className={className}
    >
      {children}
    </a>
  );
}

const ROW = "flex h-9 items-center justify-between gap-4 rounded-[5px] px-2.5 text-[14px] leading-5";

/// "Download for Linux", opening a menu of the four files. `available` names
/// the files R2 holds, read on the server; the rest read "Soon".
export function LinuxMenu({ available, className }: { available: string[]; className: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={className}>
        Download for Linux
        <svg viewBox="0 0 16 16" aria-hidden className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 mt-2 w-[300px] rounded-[8px] border border-white/15 bg-[#111112] p-1.5 shadow-[0_16px_40px_-8px_#000000CC] light:border-black/10 light:bg-white light:shadow-[0_16px_40px_-12px_#00000040]">
          {LINUX_FORMATS.map((f) => (
            <div key={f.id} className="pb-1">
              <p className="px-2.5 pt-2 pb-1 font-mono text-[10px] leading-[14px] tracking-[0.06em] text-[#8A8A8A] uppercase">
                {f.name} · {f.target}
              </p>
              {(["x64", "arm64"] as const).map((arch) => {
                const file = f.files[arch];
                return available.includes(file) ? (
                  <LinuxFileLink
                    key={arch}
                    file={file}
                    format={f.id}
                    arch={arch}
                    from="hero"
                    className={`${ROW} text-white transition-colors hover:bg-white/10 light:text-[#0A0A0A] light:hover:bg-black/5`}
                  >
                    {arch}
                    <span className="font-mono text-[11px] text-white/40 light:text-black/40">{file}</span>
                  </LinuxFileLink>
                ) : (
                  <div key={arch} aria-disabled="true" className={`${ROW} text-white/35 light:text-black/30`}>
                    {arch}
                    <span className="font-mono text-[10px] tracking-[0.06em] uppercase">Soon</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
