"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";

import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import { FxGlyph } from "@/components/FxGlyph";
import { OpenAIGlyph } from "@/components/OpenAIGlyph";
import Orb from "@/components/app/Orb";

import s from "./crew.module.css";

/// The "crew of agents" story as one picture: you ask the lead for something,
/// it answers that the work is three jobs and splits it, a line runs out to
/// each agent, each works in its own worktree, and a line runs back as it
/// finishes. Only lines move; nothing rides them. SMIL on one 12s clock keeps
/// every step in time; under reduced motion the clock stops on the last frame.

const LOOP = 12;
const DUR = `${LOOP}s`;
const GREEN = "#3DDC97";
/// The hero's blue, so the work in flight reads as the same page.
const BLUE = "#8fb0ff";

/// A crew can mix agents, which is half the point of running them in Dray.
/// The mark says which; the name would only say it twice.
const TASKS = [
  { title: "Sign-in screen", Glyph: ClaudeGlyph, tree: "calm-owl" },
  { title: "Onboarding copy", Glyph: OpenAIGlyph, tree: "brisk-jade" },
  { title: "Analytics events", Glyph: FxGlyph, tree: "quiet-fern" },
];

/// The loop, as fractions. Tasks leave the lead a beat apart, and finish out
/// of order on purpose: parallel work does not end in the order it began.
const SPLIT = 0.03;
const LEAVE = TASKS.map((_, i) => 0.08 + i * 0.035);
const ARRIVE = LEAVE.map((t) => t + 0.1);
const DONE = [0.48, 0.62, 0.55];
const BACK = DONE.map((d) => d + 0.08);
const WRAP = 0.76;

/// Fractions of the loop as SMIL `keyTimes`.
const kt = (...t: number[]) => t.map((n) => +n.toFixed(4)).join(";");

/// Visible from `from` to `to` (or the end of the loop).
function Show({ from, to = 1 }: { from: number; to?: number }) {
  return to < 1 ? (
    <animate attributeName="opacity" dur={DUR} repeatCount="indefinite" values="0;0;1;1;0;0" keyTimes={kt(0, from, from + 0.015, to, to + 0.015, 1)} />
  ) : (
    <animate attributeName="opacity" dur={DUR} repeatCount="indefinite" values="0;0;1;1" keyTimes={kt(0, from, from + 0.015, 1)} />
  );
}

/// A short bright stretch of `path` running its length between `from` and
/// `to`, outwards or home. One dash with a gap longer than the path, so only
/// it shows.
function Pulse({ path, from, to, color, home = false }: { path: string; from: number; to: number; color: string; home?: boolean }) {
  const [start, end] = home ? ["-1.2", "0.2"] : ["0.2", "-1.2"];
  return (
    <path d={path} pathLength={1} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeDasharray="0.12 2" opacity={0}>
      {/* Hidden outside its run: a round cap still draws a dot at a line's end. */}
      <Show from={from} to={to} />
      <animate
        attributeName="stroke-dashoffset"
        dur={DUR}
        repeatCount="indefinite"
        values={`${start};${start};${end};${end}`}
        keyTimes={kt(0, from, to, 1)}
        calcMode="spline"
        keySplines="0 0 1 1; .5 0 .2 1; 0 0 1 1"
      />
    </path>
  );
}

/// An agent's mark, centred on (x, y) and `size` across.
function Mark({ x, y, size, Glyph }: { x: number; y: number; size: number; Glyph: (p: { className?: string }) => ReactNode }) {
  return (
    <g transform={`translate(${x - size / 2} ${y - size / 2})`} color="#fff">
      <svg width={size} height={size} viewBox="0 0 24 24" overflow="visible">
        <Glyph />
      </svg>
    </g>
  );
}

/// One tall layout: the picture sits beside the section's words, in half a
/// row on a wide screen and the full width on a phone.
const L = {
  view: [440, 480],
  bubble: { x: 78, y: 18, w: 300 },
  // Level with the bubble's foot, the way a chat sets an avatar.
  you: { x: 404, y: 60 },
  lead: { x: 92, y: 156, size: 36 },
  reply: { x: 118, y: 124, w: 302 },
  card: { x: 36, w: 388, h: 64, ys: [292, 366, 440] },
  // Down a shared gutter on the left, then into each card's side, so no line
  // crosses a card.
  wire: (c: number) => `M92 182 C 92 228, 16 220, 16 256 L 16 ${c - 24} Q 16 ${c} 36 ${c}`,
};

/// The picture alone; its steps are named by `CrewSteps`, set beside it.
export function CrewArt({ className = "" }: { className?: string }) {
  const l = L;
  const ref = useRef<SVGSVGElement>(null);
  const face = useId();

  useEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    ref.current?.pauseAnimations();
    ref.current?.setCurrentTime(LOOP * 0.86);
  }, []);
  const [vw, vh] = l.view;
  const b = l.bubble;
  const r = l.reply;

  return (
    <svg ref={ref} viewBox={`0 0 ${vw} ${vh}`} className={`h-auto w-full ${className}`} aria-hidden>
      <g>
        <animate attributeName="opacity" dur={DUR} repeatCount="indefinite" values="0;1;1;0" keyTimes={kt(0, 0.02, 0.95, 1)} />

        {/* What you asked: one thing, not a plan. Yours, so it sits on the
            right beside your avatar, the lead's reply on the left beside its. */}
        <rect x={b.x} y={b.y} width={b.w} height={60} rx={18} fill="#2440CC" />
        <text x={b.x + 18} y={b.y + 25} fontSize={15} fontWeight={500} fill="#fff">Ship the onboarding flow: sign-in,</text>
        <text x={b.x + 18} y={b.y + 45} fontSize={15} fontWeight={500} fill="#fff">the welcome copy and analytics.</text>
        {/* Your face: Yogesh's own photo, off his site. */}
        <clipPath id={face}>
          <circle cx={l.you.x} cy={l.you.y} r={18} />
        </clipPath>
        <image href="/avatars/crew-you.jpg" x={l.you.x - 18} y={l.you.y - 18} width={36} height={36} clipPath={`url(#${face})`} />

        {/* The lead, and what it makes of it: three jobs, one session each.
            Its words change once every line has come home. */}
        <Mark x={l.lead.x} y={l.lead.y} size={l.lead.size} Glyph={ClaudeGlyph} />
        <g opacity={0}>
          <Show from={SPLIT} />
          <rect x={r.x} y={r.y} width={r.w} height={64} rx={18} fill="rgb(255 255 255 / .08)" />
          <g fontSize={14} fill="rgb(255 255 255 / .9)">
            <g>
              <Show from={SPLIT} to={WRAP} />
              <text x={r.x + 18} y={r.y + 27}>Each of these is its own job.</text>
              <text x={r.x + 18} y={r.y + 47}>Starting a session for each.</text>
            </g>
            <g opacity={0}>
              <Show from={WRAP + 0.02} />
              <text x={r.x + 18} y={r.y + 27}>All three are done.</text>
              <text x={r.x + 18} y={r.y + 47} fill="rgb(255 255 255 / .6)">Ready for your review.</text>
            </g>
          </g>
        </g>

        {TASKS.map((t, i) => {
          const c = l.card.ys[i];
          const top = c - l.card.h / 2;
          const wire = l.wire(c);
          const ox = l.card.x + 30;
          const tx = l.card.x + 56;
          const sx = l.card.x + l.card.w - 30;
          return (
            <g key={t.title}>
              {/* The line out to the agent, drawn as the work is handed over. */}
              <path d={wire} pathLength={1} fill="none" stroke="rgb(255 255 255 / .22)" strokeWidth={1.5} strokeDasharray="1">
                <animate attributeName="stroke-dashoffset" dur={DUR} repeatCount="indefinite" values="1;1;0;0" keyTimes={kt(0, LEAVE[i], ARRIVE[i], 1)} />
              </path>
              <Pulse path={wire} from={LEAVE[i]} to={ARRIVE[i]} color={BLUE} />
              {/* Work flowing down it while the agent is busy. */}
              <path d={wire} pathLength={1} fill="none" stroke={BLUE} strokeWidth={2} strokeDasharray="0.015 0.035" strokeLinecap="round" opacity={0}>
                <Show from={ARRIVE[i]} to={DONE[i]} />
                <animate attributeName="stroke-dashoffset" dur="1.2s" repeatCount="indefinite" values="0;-0.05" />
              </path>
              {/* The report coming home. */}
              <Pulse path={wire} from={DONE[i]} to={BACK[i]} color={GREEN} home />

              <g opacity={0}>
                <Show from={ARRIVE[i] - 0.01} />
                <rect x={l.card.x} y={top} width={l.card.w} height={l.card.h} rx={20} fill="rgb(255 255 255 / .05)" />
                <Mark x={ox} y={c} size={22} Glyph={t.Glyph} />
                <text x={tx} y={c - 2} fontSize={14} fontWeight={600} fill="#fff">
                  {t.title}
                </text>
                <text x={tx} y={c + 15} fontSize={12} fill="rgb(255 255 255 / .6)">
                  worktree {t.tree}
                </text>
                {/* The app's own working orb while the agent works, then a check. */}
                <g opacity={0}>
                  <Show from={ARRIVE[i]} to={DONE[i]} />
                  <foreignObject x={sx - 12} y={c - 12} width={24} height={24}>
                    <Orb size={24} />
                  </foreignObject>
                </g>
                <g opacity={0}>
                  <Show from={DONE[i]} />
                  <path d={`M${sx - 6} ${c} l4 4 l8 -8`} fill="none" stroke="rgb(255 255 255 / .85)" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
                </g>
              </g>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

const STEPS = ["You ask once", "Each task gets an agent and a worktree", "Reports come back as they finish"];

/// The three steps the picture tells, lit in turn on the picture's clock.
export function CrewSteps({ className = "" }: { className?: string }) {
  return (
    <ol className={`flex flex-col gap-3 ${className}`}>
      {STEPS.map((step, i) => (
        <li key={step} className={`flex items-center gap-3 ${s.step}`} style={{ animationName: s[`step${i}`] }}>
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white/10 text-xs font-medium">{i + 1}</span>
          {step}
        </li>
      ))}
    </ol>
  );
}
