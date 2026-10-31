"use client";

import { useRef, useState } from "react";

import { DownloadButton } from "@/components/DownloadButton";
import { Title } from "@/components/home/Section";
import { Stripes } from "@/components/home/Stripes";
import { FEEDBACK, INSTALL_LINE, REPO, SPONSOR } from "@/lib/links";

const LABEL = "font-mono text-[11px] leading-[14px] tracking-[0.06em] text-white/70 uppercase";

const LINKS = [
  { label: "Docs", href: "/docs" },
  { label: "Changelog", href: "/changelog" },
  { label: "GitHub", href: REPO, out: true },
  { label: "X", href: FEEDBACK, out: true },
  { label: "Sponsor", href: SPONSOR, out: true },
];

/// The last blue band: the closing line, both ways in, and the footer.
export function Closing() {
  return (
    <section className="relative flex flex-col overflow-clip bg-[#1612F8] px-5 pt-[120px] sm:px-8 lg:min-h-[960px]">
      <Stripes />
      <Tiles />

      <div className="relative mx-auto w-full max-w-[960px]">
        <Title lead="Your subscription, your favourite harness.">
          <span className="text-white sm:block">Mix and switch freely.</span>
        </Title>

        <div className="mt-10 grid divide-y divide-white/30 border-y border-white/30 bg-white/10 sm:grid-cols-2 sm:divide-x sm:divide-y-0 sm:border-x">
          <Way label="On your Mac" title="Download the app.">
            <DownloadButton from="cta" className="inline-flex h-10 items-center gap-2 self-start rounded-[6px] bg-white px-4 text-[14px] leading-5 font-medium text-[#0B0B0F] shadow-[inset_0_-1px_0_#4D4C4C,0_1px_2px_#00000040] transition-opacity hover:opacity-90 [&>svg]:-mt-0.5" />
          </Way>
          <Way label="On a server" title="Install the CLI.">
            <CopyLine />
          </Way>
        </div>
      </div>

      <footer className="relative mx-auto mt-[120px] flex w-full max-w-[960px] flex-col gap-4 pb-[220px] sm:flex-row sm:items-center sm:justify-between lg:mt-auto lg:pb-[276px]">
        <p className={LABEL}>© {new Date().getFullYear()} Dray</p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              {...(l.out ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              className={`${LABEL} transition-colors hover:text-white`}
            >
              {l.label}
            </a>
          ))}
        </nav>
        <p className={LABEL}>Free and open source</p>
      </footer>
    </section>
  );
}

/// One of the two ways in: a label, a line, and the thing to do at the foot.
function Way({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[200px] min-w-0 flex-col justify-between gap-8 p-6">
      <div className="flex flex-col gap-1.5">
        <p className={LABEL}>{label}</p>
        <h3 className="text-[20px] leading-[26px] tracking-[-0.02em] text-white">{title}</h3>
      </div>
      {children}
    </div>
  );
}

/// The install line with a Copy that says when it worked. Scrolls rather than
/// wraps, since a command broken over two lines reads as two commands.
function CopyLine() {
  const [copied, setCopied] = useState(false);
  const line = useRef<HTMLSpanElement>(null);

  return (
    <div className="flex h-10 items-center gap-3 rounded-[6px] bg-[#0B0A6E] px-3.5">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] leading-4 tracking-[-0.02em] whitespace-nowrap text-[#CFCFCF] [scrollbar-width:none]">
        <span className="text-[#FFE14D] select-none">$ </span>
        <span ref={line}>{INSTALL_LINE}</span>
      </code>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard.writeText(INSTALL_LINE).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            // Clipboard refused: select the line so ⌘C takes it instead.
            () => line.current && window.getSelection()?.selectAllChildren(line.current),
          )
        }
        className={`${LABEL} shrink-0 transition-colors hover:text-white`}
      >
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

/// The darker tile band along the foot and three loose lit tiles, anchored to
/// the bottom so the band stays at the foot however tall the stack gets.
function Tiles() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 1440 960"
      width="1440"
      height="960"
      shapeRendering="crispEdges"
      className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2"
    >
      <path d="M0 900h1440v60h-1440z" fill="#00000033" />
      <path d="M0 840h180v60h-180zM1020 840h300v60h-300z" fill="#0000001A" />
      <path
        d="M0 780h180v60h-180zM180 840h120v60h-120zM480 840h240v60h-240zM960 840h60v60h-60zM1020 780h300v60h-300zM1320 840h60v60h-60zM120 600h60v60h-60zM660 540h60v60h-60zM1260 600h60v60h-60z"
        fill="#FFFFFF14"
      />
    </svg>
  );
}
