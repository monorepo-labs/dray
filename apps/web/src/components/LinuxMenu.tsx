"use client";

import { useEffect, useRef, useState } from "react";

import { BetaTag } from "@/components/BetaTag";
import { LinuxGlyph } from "@/components/LinuxGlyph";
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

const ARCHES = ["x64", "arm64"] as const;
const TEXT = "text-white light:text-[#0A0A0A]";
const MUTED = "text-white/45 light:text-black/45";
const CHIP = `inline-flex h-8 flex-1 items-center justify-center rounded-[5px] border border-white/15 px-3 text-[13px] font-medium transition-colors hover:bg-white/10 light:border-black/15 light:hover:bg-black/5 ${TEXT}`;
const BETA = "text-[#A1A1A1] light:text-[#6B6B6B]";

/// "Download for Linux", opening a card per format with a button per
/// architecture.
export function LinuxMenu({ className }: { className: string }) {
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
        <LinuxGlyph className="-mt-0.5 size-4" />
        Download for Linux
        <svg viewBox="0 0 16 16" aria-hidden className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 mt-2 w-[420px] rounded-[8px] border border-white/15 bg-[#111112] p-2 shadow-[0_16px_40px_-8px_#000000CC] light:border-black/10 light:bg-white light:shadow-[0_16px_40px_-12px_#00000040]">
          <div className="grid grid-cols-2 gap-2">
            {LINUX_FORMATS.map((f) => (
              <div key={f.id} className="flex flex-col gap-3 rounded-[6px] bg-white/[0.05] p-3 light:bg-black/[0.04]">
                <div>
                  <p className={`flex items-center gap-2 text-[15px] font-medium ${TEXT}`}>
                    {f.name}
                    <BetaTag className={BETA} />
                  </p>
                  <p className={`text-[12px] leading-4 ${MUTED}`}>{f.target}</p>
                </div>
                <div className="flex gap-1.5">
                  {ARCHES.map((arch) => (
                    <LinuxFileLink key={arch} file={f.files[arch]} format={f.id} arch={arch} from="hero" className={CHIP}>
                      {arch}
                    </LinuxFileLink>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
