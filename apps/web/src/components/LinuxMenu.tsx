"use client";

import { useEffect, useRef, useState } from "react";

import { BetaTag } from "@/components/BetaTag";
import { LINUX_FORMATS, linuxUrl, type LinuxArch, type LinuxFormat, type Variant } from "@/lib/linux";
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
const PANEL =
  "absolute top-full left-0 z-30 mt-2 rounded-[8px] border border-white/15 bg-[#111112] shadow-[0_16px_40px_-8px_#000000CC] light:border-black/10 light:bg-white light:shadow-[0_16px_40px_-12px_#00000040]";
const MONO_LABEL = "font-mono text-[10px] leading-[14px] tracking-[0.06em] text-[#8A8A8A] uppercase";
const ROW = "flex h-9 items-center justify-between gap-4 rounded-[5px] px-2.5 text-[14px] leading-5";
const HOVER = "transition-colors hover:bg-white/10 light:hover:bg-black/5";
const TEXT = "text-white light:text-[#0A0A0A]";
const MUTED = "text-white/45 light:text-black/45";
const CHIP = `inline-flex h-8 items-center justify-center gap-1.5 rounded-[5px] border border-white/15 px-3 text-[13px] font-medium ${TEXT} ${HOVER} light:border-black/15`;
const BETA = "text-[#A1A1A1] light:text-[#6B6B6B]";

/// "Download for Linux", opening a menu of the four files.
export function LinuxMenu({
  className,
  variant = "A",
  defaultOpen = false,
}: {
  className: string;
  variant?: Variant;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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

  const Body = BODIES[variant];
  return (
    <div ref={box} className="relative">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={className}>
        Download for Linux
        <svg viewBox="0 0 16 16" aria-hidden className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && <Body />}
    </div>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v10M3.5 8.5 8 13l4.5-4.5" />
    </svg>
  );
}

/// A: one row per file, grouped by format, filename on the right; Beta heads it.
function ListBody() {
  return (
    <div className={`${PANEL} w-[300px] p-1.5`}>
      <div className="flex items-center justify-between px-2.5 pt-1.5 pb-1">
        <span className={`text-[13px] font-medium ${TEXT}`}>Dray for Linux</span>
        <BetaTag className={BETA} />
      </div>
      {LINUX_FORMATS.map((f) => (
        <div key={f.id} className="pb-1">
          <p className={`px-2.5 pt-2 pb-1 ${MONO_LABEL}`}>
            {f.name} · {f.target}
          </p>
          {ARCHES.map((arch) => (
            <LinuxFileLink key={arch} file={f.files[arch]} format={f.id} arch={arch} from="hero" className={`${ROW} ${TEXT} ${HOVER}`}>
              {arch}
              <span className={`font-mono text-[11px] ${MUTED}`}>{f.files[arch]}</span>
            </LinuxFileLink>
          ))}
        </div>
      ))}
    </div>
  );
}

/// B: a card per format side by side, arch as two buttons under each; Beta in
/// the corner.
function CardsBody() {
  return (
    <div className={`${PANEL} w-[420px] p-2`}>
      <div className="flex items-center justify-between px-1.5 pt-1 pb-2.5">
        <span className={MONO_LABEL}>Pick a file</span>
        <BetaTag className={BETA} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {LINUX_FORMATS.map((f) => (
          <div key={f.id} className="flex flex-col gap-3 rounded-[6px] bg-white/[0.05] p-3 light:bg-black/[0.04]">
            <div>
              <p className={`text-[15px] font-medium ${TEXT}`}>{f.name}</p>
              <p className={`text-[12px] leading-4 ${MUTED}`}>{f.target}</p>
            </div>
            <div className="flex gap-1.5">
              {ARCHES.map((arch) => (
                <LinuxFileLink key={arch} file={f.files[arch]} format={f.id} arch={arch} from="hero" className={`${CHIP} flex-1`}>
                  {arch}
                </LinuxFileLink>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/// C: pick the chip first (x64 or arm64), then one row per format.
function ToggleBody() {
  const [arch, setArch] = useState<LinuxArch>("x64");
  return (
    <div className={`${PANEL} w-[320px] p-1.5`}>
      <div className="flex items-center justify-between gap-3 px-1.5 pt-1 pb-2">
        <div className="flex rounded-[6px] bg-white/[0.07] p-0.5 light:bg-black/[0.05]">
          {ARCHES.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setArch(a)}
              className={`h-7 cursor-pointer rounded-[5px] px-3 text-[13px] font-medium transition-colors ${
                a === arch ? "bg-white text-[#0B0B0F] light:bg-[#0A0A0A] light:text-white" : `${MUTED} hover:text-white light:hover:text-[#0A0A0A]`
              }`}
            >
              {a}
            </button>
          ))}
        </div>
        <BetaTag className={BETA} />
      </div>
      {LINUX_FORMATS.map((f) => (
        <LinuxFileLink key={f.id} file={f.files[arch]} format={f.id} arch={arch} from="hero" className={`flex items-center justify-between gap-4 rounded-[5px] px-2.5 py-2 ${HOVER}`}>
          <span className="flex flex-col">
            <span className={`text-[14px] leading-5 font-medium ${TEXT}`}>{f.name}</span>
            <span className={`text-[12px] leading-4 ${MUTED}`}>{f.target}</span>
          </span>
          <span className={MUTED}>
            <Arrow />
          </span>
        </LinuxFileLink>
      ))}
    </div>
  );
}

/// D: one compact row per format, arch chips at its right end; Beta and a
/// feedback line at the foot.
function RowsBody() {
  return (
    <div className={`${PANEL} w-[400px] p-1.5`}>
      {LINUX_FORMATS.map((f) => (
        <div key={f.id} className="flex items-center justify-between gap-4 rounded-[5px] px-2.5 py-2.5">
          <span className="flex min-w-0 flex-col">
            <span className={`text-[14px] leading-5 font-medium ${TEXT}`}>{f.name}</span>
            <span className={`text-[12px] leading-4 ${MUTED}`}>{f.target}</span>
          </span>
          <span className="flex shrink-0 gap-1.5">
            {ARCHES.map((arch) => (
              <LinuxFileLink key={arch} file={f.files[arch]} format={f.id} arch={arch} from="hero" className={CHIP}>
                <Arrow />
                {arch}
              </LinuxFileLink>
            ))}
          </span>
        </div>
      ))}
      <div className={`mt-1 flex items-center gap-2 border-t border-white/10 px-2.5 pt-2.5 pb-1.5 text-[12px] leading-4 light:border-black/10 ${MUTED}`}>
        <BetaTag className={BETA} />
        New on Linux. Both kinds update themselves.
      </div>
    </div>
  );
}

/// E: a 2×2 grid, formats down the side and architectures across the top;
/// Beta in the header row.
function GridBody() {
  return (
    <div className={`${PANEL} w-[380px] p-3`}>
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 gap-y-2">
        <BetaTag className={`${BETA} justify-self-start`} />
        {ARCHES.map((a) => (
          <span key={a} className={`${MONO_LABEL} w-20 text-center`}>
            {a}
          </span>
        ))}
        {LINUX_FORMATS.map((f) => (
          <div key={f.id} className="contents">
            <span className="flex flex-col py-1">
              <span className={`text-[14px] leading-5 font-medium ${TEXT}`}>{f.name}</span>
              <span className={`text-[12px] leading-4 ${MUTED}`}>{f.target}</span>
            </span>
            {ARCHES.map((arch) => (
              <LinuxFileLink key={arch} file={f.files[arch]} format={f.id} arch={arch} from="hero" className={`${CHIP} h-9 w-20 px-0`}>
                <Arrow />
                <span className="sr-only">
                  {f.name} {arch}
                </span>
              </LinuxFileLink>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const BODIES: Record<Variant, () => React.JSX.Element> = {
  A: ListBody,
  B: CardsBody,
  C: ToggleBody,
  D: RowsBody,
  E: GridBody,
};
