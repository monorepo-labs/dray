import type { CSSProperties, ReactNode } from "react";
import { Orb as ThinkingOrb } from "@yogesharc/thinking-orbs";
import { AudioLines, Check, ChevronDown, Folder, Search, TextCursor, X } from "lucide-react";

import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import { VoiceOrb, type OrbState } from "./VoiceOrb";

/// Dray Island, drawn. Every value here is read off apps/island/Island — the
/// card is pure black on the system font, greys are white at a fixed opacity,
/// and sizes are in points, which the scenes draw one to one before scaling.

export const NOTCH_H = 34;
export const NOTCH_W = 200;
export const EAR = 12;
export const ISLAND_W = 520;

/// The system face the real panel draws in. SF on a Mac, the platform's own
/// UI face elsewhere.
export const SYSTEM_FONT: CSSProperties = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif',
  letterSpacing: "-0.003em",
};

const YELLOW = "#E5C057";
const GREEN = "#09BB83";

/// The notch grown downward (NotchShape.swift): straight sides, rounded bottom
/// corners, and the top corners flaring out along the screen's top edge as
/// 12pt ears. The ears are drawn outside the box, so `width` is the content's.
/// The shadow is a drop-shadow so it follows the ears as well as the body.
export function NotchCard({
  children,
  radius = 20,
  className = "",
  style,
  glow,
}: {
  children?: ReactNode;
  radius?: number;
  className?: string;
  style?: CSSProperties;
  /// The attention pill's fresh-news edge.
  glow?: boolean;
}) {
  return (
    <div
      className={`relative bg-black text-white ${className}`}
      style={{
        ...SYSTEM_FONT,
        borderRadius: `0 0 ${radius}px ${radius}px`,
        filter: glow
          ? `drop-shadow(0 0 1px ${YELLOW}) drop-shadow(0 0 12px ${YELLOW}88)`
          : "drop-shadow(0 4px 12px rgba(0,0,0,.35))",
        transition: "filter 600ms ease-out",
        ...style,
      }}
    >
      <Ear side="left" size={EAR} />
      <Ear side="right" size={EAR} />
      {children}
    </div>
  );
}

/// One flare, NotchShape's own quad curve: from the screen edge at the outer
/// corner, bending down into the side `size` below it. Overlaps the body by
/// half a point so the two never show a seam when scaled.
function Ear({ side, size }: { side: "left" | "right"; size: number }) {
  return (
    <svg
      aria-hidden
      className="absolute top-0"
      width={size + 0.5}
      height={size}
      viewBox={`0 0 ${size + 0.5} ${size}`}
      style={{ [side]: -size, transform: side === "right" ? "scaleX(-1)" : undefined }}
    >
      <path d={`M0 0 Q${size} 0 ${size} ${size} L${size + 0.5} ${size} L${size + 0.5} 0 Z`} fill="#000" />
    </svg>
  );
}

/// The hardware notch: a cut-out of the bezel, so it starts at the screen's top
/// edge with small flares, and rounds off under. Never a logo, never a camera
/// dot people would read as a brand mark.
export function HardwareNotch({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`absolute top-0 left-1/2 -translate-x-1/2 bg-black ${className}`}
      style={{ width: NOTCH_W, height: NOTCH_H, borderRadius: "0 0 10px 10px" }}
    >
      <Ear side="left" size={6} />
      <Ear side="right" size={6} />
    </div>
  );
}

/// The title row: the working orb, the task, the hints.
export function TitleRow({ title, working = true, hints = true }: { title: string; working?: boolean; hints?: boolean }) {
  return (
    <div className="flex h-[18px] items-center gap-2">
      {working && (
        <span className="flex size-4 items-center justify-center text-white/70">
          <ThinkingOrb state="working" size={16} label="Working" />
        </span>
      )}
      <span className="truncate text-[13px] font-semibold text-white/70">{title}</span>
      {hints && (
        <span className="ml-auto flex shrink-0 gap-3 text-[12px] text-white/30">
          <span>⌘N New</span>
          <span>↑↓ Tasks</span>
          <span>⌘Esc</span>
        </span>
      )}
    </div>
  );
}

/// The input row: the orb, the placeholder, the capture camera, send.
export function InputRow({ orb = "idle", running = true }: { orb?: OrbState; running?: boolean }) {
  return (
    <div className="flex h-7 items-center gap-2">
      <VoiceOrb size={24} state={orb} running={running} />
      <span className="flex-1 truncate text-[13px] text-white/30">⌃ to speak, ⌘⏎ Queue, ⏎ Send</span>
      <ViewfinderIcon className="size-[19px] text-white/60" />
      <SendIcon />
    </div>
  );
}

/// SF's `camera.viewfinder`: corner brackets around a small camera.
export function ViewfinderIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" className={className} aria-hidden>
      <path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16" />
      <path d="M7.5 9.8c0-.7.5-1.2 1.2-1.2h1.1l.8-1.1h2.8l.8 1.1h1.1c.7 0 1.2.5 1.2 1.2v4.5c0 .7-.5 1.2-1.2 1.2H8.7c-.7 0-1.2-.5-1.2-1.2z" />
      <circle cx="12" cy="12" r="1.7" />
    </svg>
  );
}

/// SF's `arrow.up.circle.fill` at `.title2`.
export function SendIcon({ className = "" }: { className?: string }) {
  return (
    <span className={`grid size-[22px] shrink-0 place-items-center rounded-full bg-white/55 ${className}`}>
      <svg viewBox="0 0 16 16" className="size-3 text-black" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
      </svg>
    </span>
  );
}

/// A draft row, added with ⌘⏎: spoken or typed text in a 10pt tile.
export function DraftRow({ said = true, children }: { said?: boolean; children: ReactNode }) {
  const Icon = said ? AudioLines : TextCursor;
  return (
    <div className="flex items-start gap-2 rounded-[10px] bg-white/[0.06] px-2.5 py-[9px] text-[13px] leading-[18px] text-white/90">
      <Icon className="mt-px size-4 shrink-0 text-white/50" strokeWidth={1.75} />
      <span className="min-w-0 flex-1">{children}</span>
      <X className="mt-0.5 size-3.5 shrink-0 text-white/30" strokeWidth={2} />
    </div>
  );
}

/// An image row: the thumbnail up to 72pt tall, then its label.
export function ImageRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] bg-white/[0.06] p-2 text-[13px] text-white/90">
      <span className="overflow-hidden rounded-md">{children}</span>
      <span className="flex-1">{label}</span>
      <X className="size-3.5 shrink-0 self-start text-white/30" strokeWidth={2} />
    </div>
  );
}

/// The recording bar: the orb is the level meter, then the clock.
export function RecordingBar({ seconds, orb = "recording", running = true }: { seconds: number; orb?: OrbState; running?: boolean }) {
  return (
    <div className="flex h-6 items-center gap-2">
      <VoiceOrb size={24} state={orb} running={running} />
      <span className="text-[12px] text-white tabular-nums">
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </span>
    </div>
  );
}

/// A permission card's header, and the browser-like tabs when several
/// sessions are waiting.
export function AskHeader({ title, tabs }: { title: string; tabs?: string[] }) {
  return (
    <>
      {tabs && (
        <div className="-mx-1 mb-2.5 flex gap-1">
          {tabs.map((t, i) => (
            <span
              key={t}
              className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2.5 text-[12px] ${
                i === 0 ? "bg-white/[0.12] text-white/80" : "text-white/40"
              }`}
            >
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: YELLOW }} />
              <span className="truncate">{t}</span>
            </span>
          ))}
        </div>
      )}
      <div className="mb-2 flex items-center">
        <span className="text-[13px] font-semibold text-white/45">{title}</span>
        <span className="ml-auto text-[12px] text-white/30">⌘Esc</span>
      </div>
    </>
  );
}

export function PermissionBody({
  tool,
  description,
  argument,
  options,
  picked,
}: {
  tool: string;
  description: string;
  argument: string;
  options: { label: string; deny?: boolean }[];
  picked?: number;
}) {
  return (
    <div>
      <p className="text-[13px] font-medium">
        {tool}
        <span className="text-[12px] font-normal text-white/50">{"  "}{description}</span>
      </p>
      <p className="mt-1 font-mono text-[11px] text-white/50">{argument}</p>
      <div className="mt-2.5 flex flex-col gap-1">
        {options.map((o, i) => (
          <div
            key={o.label}
            className={`flex h-[30px] items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-200 ${
              picked === i ? "bg-white/20" : "bg-white/[0.08]"
            } ${o.deny ? "text-[#ff6b5e]" : ""}`}
          >
            <span className="text-white/30">{i + 1}</span>
            {o.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export function QuestionBody({
  question,
  of,
  options,
  picked,
}: {
  question: string;
  of: string;
  options: { label: string; detail: string }[];
  picked?: number;
}) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <p className="text-[13px] font-medium">{question}</p>
        <span className="ml-auto shrink-0 text-[12px] text-white/30">{of}</span>
      </div>
      <div className="mt-2.5 flex flex-col gap-1">
        {options.map((o, i) => (
          <div
            key={o.label}
            className={`flex items-start gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition-colors duration-200 ${
              picked === i ? "bg-white/20" : "bg-white/[0.08]"
            }`}
          >
            <span className="text-white/30">{i + 1}</span>
            <span>
              {o.label}
              <span className="block text-[11px] text-white/40">{o.detail}</span>
            </span>
          </div>
        ))}
        <div className="flex h-8 items-center rounded-lg bg-white/[0.08] px-2.5 text-[13px] text-white/30">
          Something else…
        </div>
      </div>
      <div className="mt-3 flex items-center gap-4 text-[13px] text-white/50">
        <span>Back</span>
        <span className="ml-auto">Skip</span>
        <span className="flex h-7 items-center rounded-full bg-white px-3 font-semibold text-black">Next  ⏎</span>
      </div>
    </div>
  );
}

/// The session switcher, a second black card under the composer.
export function Switcher({
  rows,
  selected = 0,
}: {
  rows: { title: string; project: string; status?: "waiting" | "done" }[];
  selected?: number;
}) {
  return (
    <div className="rounded-2xl bg-black p-2 text-white shadow-[0_4px_12px_rgba(0,0,0,.35)]" style={SYSTEM_FONT}>
      <div className="flex h-8 items-center gap-2 px-2">
        <Search className="size-3.5 text-white/40" strokeWidth={2} />
        <span className="text-[13px] text-white/30">Search tasks  ⌘F</span>
        <span className="ml-auto text-[12px] text-white/30">↑↓ navigate  ⏎ select</span>
      </div>
      <div className="mt-1 flex flex-col">
        {rows.map((r, i) => (
          <div
            key={r.title}
            className={`relative flex h-8 items-center gap-2 rounded-lg pr-2.5 pl-4 text-[13px] transition-colors duration-200 ${
              i === selected ? "bg-white/[0.12] text-white" : "text-white/70"
            }`}
          >
            {r.status && (
              <span
                className="absolute left-1.5 h-1.5 w-0.5 rounded-full"
                style={{ background: r.status === "waiting" ? YELLOW : GREEN, height: 12 }}
              />
            )}
            <span className="truncate">{r.title}</span>
            <span className="ml-auto shrink-0 text-white/35">{r.project}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/// The bar ⌘N puts over the input: agent and model, project, worktree,
/// stance.
export function NewSessionBar() {
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-white/70">
      <Chip>
        <ClaudeGlyph className="size-3.5" />
        Opus <span className="text-white/45">High</span>
        <ChevronDown className="size-3 text-white/40" />
      </Chip>
      <Chip>
        <Folder className="size-3.5 text-white/50" strokeWidth={1.75} />
        dray
      </Chip>
      <Chip>
        <span className="relative h-3.5 w-6 rounded-full" style={{ background: GREEN }}>
          <span className="absolute top-0.5 right-0.5 size-2.5 rounded-full bg-white" />
        </span>
        Worktree
      </Chip>
      <Chip className="ml-auto">
        Auto
        <ChevronDown className="size-3 text-white/40" />
      </Chip>
    </div>
  );
}

function Chip({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`flex h-[26px] items-center gap-1.5 rounded-full bg-white/[0.08] px-2.5 ${className}`}>{children}</span>
  );
}

/// Shut, with a session waiting: the notch-shaped pill.
export function AttentionPill({ glow }: { glow?: boolean }) {
  return (
    <NotchCard radius={16} glow={glow} style={{ paddingTop: NOTCH_H, minWidth: NOTCH_W }}>
      <div className="flex h-9 items-center justify-center gap-2 px-4 text-[13px] font-semibold">
        <span className="size-1.5 rounded-full" style={{ background: YELLOW }} />
        1 task needs attention
      </div>
    </NotchCard>
  );
}

/// Shut, with a session finished.
export function DonePill({ title }: { title: string }) {
  return (
    <NotchCard radius={16} style={{ paddingTop: NOTCH_H, minWidth: NOTCH_W }}>
      <div className="flex h-10 items-center gap-2 pr-2 pl-4 text-[13px] whitespace-nowrap">
        <span className="size-1.5 rounded-full" style={{ background: GREEN }} />
        <span className="font-semibold">Done</span>
        <span className="text-white/60">{title}</span>
        <span className="ml-3 flex h-6 items-center rounded-full bg-white/[0.12] px-2.5 text-[12px] text-white/85">
          Open in app
        </span>
      </div>
    </NotchCard>
  );
}

/// The "Sent" beat after a send.
export function SentLabel() {
  return (
    <span className="flex h-5 items-center gap-1.5 px-1 text-[13px] font-semibold">
      <Check className="size-3.5" strokeWidth={3} />
      Sent
    </span>
  );
}
