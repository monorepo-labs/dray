"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AudioLines, Lock, RotateCw } from "lucide-react";

import { MenuBar } from "./Desktop";
import { HERO_BG_FLIPPED } from "./Stage";
import {
  DonePill,
  DraftRow,
  ImageRow,
  InputRow,
  ISLAND_W,
  NOTCH_H,
  NOTCH_W,
  NotchCard,
  RecordingBar,
  SentLabel,
  SYSTEM_FONT,
  TitleRow,
} from "./Island";
import s from "./hero.module.css";

/// The stage, in points. Everything below is placed in these units and the
/// whole stage is scaled to the column once.
const W = 1200;
const H = 720;
const BEZEL = 14;
/// The screen's own chrome is drawn at a 14" MacBook's 1512pt and scaled to
/// fit, or Island's 520pt card would cover twice its share of the screen.
const SYS = W / 1512;

/// One loop of the story: open Island, talk, circle the bug while talking,
/// the circle flies into the draft, send, and the fix lands.
const PHASES = [
  ["shut", 1000],
  ["open", 1300],
  ["listen1", 2400],
  ["draw", 1300],
  ["rest", 700],
  ["capture", 900],
  ["listen2", 2300],
  ["transcribe", 700],
  ["review", 2400],
  ["sent", 900],
  ["working", 1500],
  ["done", 3600],
] as const;
type Phase = (typeof PHASES)[number][0];

const RECORDING: Phase[] = ["listen1", "draw", "rest", "capture", "listen2", "transcribe"];
const SAID_1 = "The Continue button isn't lined up with the fields.";
const SAID_2 = "Make it full width, same as the inputs.";
const TITLE = "Sign-in page polish";

/// The browser window, its page, and the sign-in card on it.
const WIN = { x: 150, y: 92, w: 660, h: 520 };
const CARD = { x: 330, y: 202, w: 300, h: 304 };
/// The button before the fix, in the card's own units.
const BUG = { x: 70, w: 150 };

/// The pen's stroke: a loose loop round the button, a little past where it
/// began, the way a hand closes a circle.
const INK = (() => {
  const cx = CARD.x + BUG.x + BUG.w / 2;
  const cy = CARD.y + 260;
  const pts: [number, number][] = [];
  const a0 = (200 * Math.PI) / 180;
  const sweep = (395 * Math.PI) / 180;
  for (let i = 0; i <= 64; i++) {
    const k = i / 64;
    const a = a0 + sweep * k;
    const wob = 1 + 0.05 * Math.sin(a * 3 + 1) + 0.07 * k;
    pts.push([cx + Math.cos(a) * 104 * wob, cy + Math.sin(a) * 36 * wob]);
  }
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = 26;
  const box = {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    w: Math.max(...xs) - Math.min(...xs) + pad * 2,
    h: Math.max(...ys) - Math.min(...ys) + pad * 2,
  };
  return { d, start: pts[0], end: pts[pts.length - 1], box };
})();

const THUMB_H = 72;

export function IslandHero({ className }: { className?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const [still, setStill] = useState(false);
  const [index, setIndex] = useState(0);
  const [stillPhase, setStillPhase] = useState<Phase>("review");
  /// Bumped by a step being picked, so picking the lit one plays it again.
  const [epoch, setEpoch] = useState(0);
  const phase: Phase = still ? stillPhase : PHASES[index][0];

  const jump = (step: Step) => {
    setStillPhase(step.still);
    setIndex(PHASES.findIndex(([p]) => p === step.phases[0]));
    setEpoch((n) => n + 1);
  };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setStill(media.matches);
    motion();
    media.addEventListener("change", motion);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    return () => {
      media.removeEventListener("change", motion);
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  // One timer at a time, and none off screen: the story waits where it is.
  useEffect(() => {
    if (!visible || still) return;
    const id = setTimeout(() => setIndex((i) => (i + 1) % PHASES.length), PHASES[index][1]);
    return () => clearTimeout(id);
  }, [index, visible, still, epoch]);

  const running = visible && !still;
  const seconds = useSeconds(RECORDING.includes(phase), running, epoch);

  // A phone keeps Island legible and crops the desktop round it, rather than
  // shrinking the whole screen until the card is a smudge.
  const full = W + BEZEL * 2;
  const scale = width === 0 ? 1 : width < 720 ? width / 580 : Math.min(1.08, width / full);
  const left = (width - full * scale) / 2;

  return (
    <div className={className}>
      <div
        ref={wrap}
        className="relative w-full overflow-hidden"
        style={{
          height: H * scale,
          maskImage: "linear-gradient(to bottom, black 78%, transparent)",
          WebkitMaskImage: "linear-gradient(to bottom, black 78%, transparent)",
        }}
      >
        <p className="sr-only">
          Dray Island hangs from the MacBook notch. Tap Control to open it, tap again to dictate, hold
          Shift to circle part of the screen while you talk, and send it all to a coding agent
          without leaving the app you are in.
        </p>
        <div
          aria-hidden
          className="absolute top-0 select-none"
          style={{
            left,
            width: full,
            height: H,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            visibility: width ? "visible" : "hidden",
          }}
        >
          {/* The lid's sides. Nothing runs across the top: the display meets
              the lid's edge there and the notch is cut out of it, so bezel,
              notch and Island read as one black. */}
          <div className="absolute inset-0 rounded-t-[22px] bg-black" />
          <div
            className="absolute overflow-hidden rounded-t-[12px]"
            style={{ left: BEZEL, top: 0, width: W, height: H, ...HERO_BG_FLIPPED }}
          >
            <Scene key={epoch} phase={phase} seconds={seconds} running={running} />
          </div>
        </div>
      </div>
      <Steps phase={phase} onPick={jump} />
    </div>
  );
}

/// The clock beside the orb: counts while dictating, and is back at zero by
/// the time the next recording starts.
function useSeconds(recording: boolean, running: boolean, epoch: number) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => setSeconds(0), [epoch]);
  useEffect(() => {
    if (!recording) return setSeconds(0);
    if (!running) return;
    const id = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [recording, running, epoch]);
  return seconds;
}

function Scene({ phase, seconds, running }: { phase: Phase; seconds: number; running: boolean }) {
  const recording = RECORDING.includes(phase);
  const fixed = phase === "done";
  const drawn = ["draw", "rest"].includes(phase);

  return (
    <div className="absolute inset-0" style={SYSTEM_FONT}>
      <Editor />
      <Browser fixed={fixed} loading={phase === "working"} />
      <AtScreenScale>
        <MenuBar />
      </AtScreenScale>

      {/* The ink, burned onto the live screen, and the dot that lays it. */}
      {(drawn || phase === "capture") && (
        <svg className="pointer-events-none absolute inset-0" width={W} height={H}>
          <path
            d={INK.d}
            pathLength={1}
            fill="none"
            stroke="#FF3B30"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={phase === "capture" ? s.inkGone : s.ink}
          />
        </svg>
      )}
      {drawn && (
        <span
          className={`absolute top-0 left-0 size-3 rounded-full border-2 border-white bg-[#FF3B30] shadow-[0_1px_3px_rgba(0,0,0,.4)] ${s.pen}`}
          style={{ offsetPath: `path("${INK.d}")` } as CSSProperties}
        />
      )}
      {phase === "capture" && <Flight />}

      <Cursor phase={phase} />
      <Subtitles phase={phase} />

      <AtScreenScale>
      <Card phase={phase} seconds={seconds} running={running} recording={recording} />

      <div
        className="absolute top-0 left-1/2 origin-top"
        style={{
          transform: `translateX(-50%) scale(${fixed ? 1 : 0.5})`,
          opacity: fixed ? 1 : 0,
          transition: fixed
            ? "transform 320ms cubic-bezier(.34,1.32,.64,1) 600ms, opacity 160ms ease-out 600ms"
            : "transform 150ms ease-in, opacity 150ms ease-in",
        }}
      >
        <DonePill title={TITLE} />
      </div>
      </AtScreenScale>
    </div>
  );
}

function AtScreenScale({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute top-0 left-0 origin-top-left" style={{ width: W / SYS, height: H / SYS, transform: `scale(${SYS})` }}>
      {children}
    </div>
  );
}

/// Island itself: one black card whose size follows what it holds.
function Card({ phase, seconds, running, recording }: { phase: Phase; seconds: number; running: boolean; recording: boolean }) {
  const shown = !["shut", "working", "done"].includes(phase);
  const size =
    phase === "review"
      ? { w: ISLAND_W, h: 292 }
      : phase === "open"
        ? { w: ISLAND_W, h: 112 }
        : recording
          ? { w: NOTCH_W, h: 82 }
          : { w: NOTCH_W, h: 78 };

  let body: ReactNode = null;
  if (phase === "open") body = <Composer running={running} />;
  else if (phase === "review") body = <Composer running={running} rows />;
  else if (phase === "sent") body = <SentLabel />;
  else if (recording)
    body = (
      <RecordingBar
        seconds={seconds}
        orb={phase === "transcribe" ? "transcribing" : "recording"}
        running={running}
      />
    );
  const kind = recording ? "rec" : phase;

  return (
    <div
      className="absolute top-0 left-1/2 origin-top"
      style={{
        transform: `translateX(-50%) scale(${shown ? 1 : 0.5})`,
        opacity: shown ? 1 : 0,
        transition: shown
          ? "transform 320ms cubic-bezier(.34,1.32,.64,1), opacity 180ms ease-out"
          : "transform 150ms ease-in, opacity 150ms ease-in",
      }}
    >
      <NotchCard
        className="overflow-visible"
        style={{
          width: size.w,
          height: size.h,
          transition: "width 250ms cubic-bezier(.2,.9,.3,1), height 250ms cubic-bezier(.2,.9,.3,1)",
        }}
      >
        <div className="absolute inset-x-0 bottom-0 overflow-hidden px-3 pb-3" style={{ top: NOTCH_H + 12 }}>
          <div key={kind} className={`${s.fadeIn} ${kind === "rec" || kind === "sent" ? "flex justify-center" : ""}`}>
            {body}
          </div>
        </div>
      </NotchCard>
    </div>
  );
}

function Composer({ rows = false, running }: { rows?: boolean; running: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <TitleRow title={TITLE} working={false} />
      {rows && (
        <div className="flex flex-col gap-1.5">
          <DraftRow>{SAID_1}</DraftRow>
          <ImageRow label="Image 1">
            <Thumb />
          </ImageRow>
          <DraftRow>{SAID_2}</DraftRow>
        </div>
      )}
      <InputRow running={running} />
    </div>
  );
}

/// What the capture holds: the page under the box, the ink burned in.
function Shot() {
  const { box } = INK;
  return (
    <div className="relative overflow-hidden bg-[#0b0b0d]" style={{ width: box.w, height: box.h }}>
      <div className="absolute" style={{ left: CARD.x - box.x, top: CARD.y - box.y }}>
        <SignInCard fixed={false} />
      </div>
      <svg className="absolute inset-0" viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} width={box.w} height={box.h}>
        <path d={INK.d} fill="none" stroke="#FF3B30" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Thumb() {
  const k = THUMB_H / INK.box.h;
  return (
    <div style={{ width: INK.box.w * k, height: THUMB_H }}>
      <div style={{ transform: `scale(${k})`, transformOrigin: "top left" }}>
        <Shot />
      </div>
    </div>
  );
}

/// The capture leaving the screen: a flash where it was taken, then a flight
/// into the notch, shrinking to 96pt wide and fading to half.
function Flight() {
  const { box } = INK;
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setGone(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  const k = 96 / box.w;
  const dx = W / 2 - (box.x + box.w / 2);
  const dy = NOTCH_H + 20 - box.y;
  return (
    <div
      className={`absolute origin-top rounded-md shadow-[0_8px_24px_rgba(0,0,0,.35)] ${s.fly}`}
      style={{
        left: box.x,
        top: box.y,
        transform: gone ? `translate(${dx}px, ${dy}px) scale(${k})` : "none",
        opacity: gone ? 0.5 : 1,
      }}
    >
      <div className="overflow-hidden rounded-md ring-1 ring-white">
        <Shot />
      </div>
      <span className={`absolute inset-0 rounded-md bg-white ${s.flash}`} />
    </div>
  );
}

/// Where the pointer is through the loop: resting, on its way to the button,
/// and parked once the pen is down.
function Cursor({ phase }: { phase: Phase }) {
  const pen = phase === "draw" || phase === "rest";
  const atInk = ["listen1", "draw", "rest", "capture", "listen2", "transcribe", "review", "sent"].includes(phase);
  const [x, y] = atInk ? INK.end : phase === "working" || phase === "done" ? [760, 585] : [700, 560];
  return (
    <svg
      viewBox="0 0 20 26"
      className="absolute top-0 left-0 h-[23px] w-[18px] drop-shadow-[0_1px_2px_rgba(0,0,0,.4)]"
      style={{
        transform: `translate(${x - 2}px, ${y - 2}px)`,
        opacity: pen ? 0 : 1,
        transition: `transform ${phase === "listen1" ? "1100ms cubic-bezier(.5,0,.2,1) 900ms" : "900ms cubic-bezier(.5,0,.2,1)"}, opacity 120ms`,
      }}
    >
      <path d="M2 2v19l5-4.6 3.3 7.4 3-1.3-3.2-7.2H17z" fill="#000" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/// What is being said, as captions. The page's device, not Island's: Island
/// keeps the words to itself until it opens.
function Subtitles({ phase }: { phase: Phase }) {
  const line = ["listen1", "draw", "rest", "capture"].includes(phase)
    ? SAID_1
    : phase === "listen2" || phase === "transcribe"
      ? SAID_2
      : null;
  return (
    <div className="absolute inset-x-0 flex justify-center" style={{ top: 636 }}>
      {line && (
        <p
          key={line}
          className={`flex max-w-[560px] items-center gap-2.5 rounded-xl bg-black/60 px-4 py-2 text-[19px] leading-snug font-medium text-white backdrop-blur-md ${s.fadeIn}`}
        >
          <AudioLines className="size-5 shrink-0 text-white/60" strokeWidth={2} />
          <span>
            {line.split(" ").map((w, i) => (
              <span key={i} className={s.word} style={{ "--i": phase === "listen1" || phase === "listen2" ? i : 0 } as CSSProperties}>
                {w}
                {" "}
              </span>
            ))}
          </span>
        </p>
      )}
    </div>
  );
}

function Browser({ fixed, loading }: { fixed: boolean; loading: boolean }) {
  return (
    <div
      className="absolute overflow-hidden rounded-xl bg-[#1d1d1f] ring-1 ring-white/12"
      style={{ left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h, boxShadow: "0 30px 70px -20px rgba(0,0,0,.65)" }}
    >
      <div className="relative flex h-10 items-center px-4">
        <TrafficLights />
        <div className="absolute left-1/2 flex h-7 w-[300px] -translate-x-1/2 items-center gap-2 overflow-hidden rounded-lg bg-white/[0.08] px-3 text-[12px] text-white/60">
          <Lock className="size-3 text-white/40" strokeWidth={2.25} />
          localhost:3000/sign-in
          <RotateCw className="ml-auto size-3 text-white/40" strokeWidth={2.25} />
          {loading && <span className={`absolute inset-x-0 bottom-0 h-0.5 origin-left bg-[#4DD9FF] ${s.loadBar}`} />}
        </div>
      </div>
      <div className="relative bg-[#0b0b0d]" style={{ height: WIN.h - 40 }}>
        <div
          className="absolute transition-opacity duration-300"
          style={{ left: CARD.x - WIN.x, top: CARD.y - WIN.y - 40, opacity: loading ? 0.35 : 1 }}
        >
          <SignInCard fixed={fixed} />
        </div>
      </div>
    </div>
  );
}

/// The page the reader is looking at, with the bug in it: a button that does
/// not line up with the fields above it.
function SignInCard({ fixed }: { fixed: boolean }) {
  return (
    <div
      className="relative rounded-[14px] border border-[#27272a] bg-[#18181b] text-[#fafafa] shadow-[0_1px_2px_rgba(0,0,0,.4)]"
      style={{ width: CARD.w, height: CARD.h, ...SYSTEM_FONT }}
    >
      <div className="absolute top-6 left-6 flex items-center gap-2.5">
        <span className="size-7 rounded-lg bg-[linear-gradient(135deg,#FF7340,#8C66FF)]" />
        <div>
          <p className="text-[15px] leading-tight font-semibold">Welcome back</p>
          <p className="text-[12px] text-[#a1a1aa]">Sign in to Acme</p>
        </div>
      </div>
      <Field top={96} label="Email" value="ada@acme.dev" />
      <Field top={164} label="Password" value="••••••••••" />
      <div
        className="absolute top-[240px] flex h-10 items-center justify-center rounded-lg bg-[#fafafa] text-[13px] font-medium text-[#18181b]"
        style={{
          left: fixed ? 24 : BUG.x,
          width: fixed ? CARD.w - 48 : BUG.w,
          transition: "left 500ms cubic-bezier(.2,.9,.3,1), width 500ms cubic-bezier(.2,.9,.3,1)",
        }}
      >
        Continue
      </div>
    </div>
  );
}

function Field({ top, label, value }: { top: number; label: string; value: string }) {
  return (
    <div className="absolute inset-x-6" style={{ top }}>
      <p className="mb-1.5 text-[12px] font-medium text-[#d4d4d8]">{label}</p>
      <div className="flex h-[38px] items-center rounded-lg border border-[#3f3f46] px-3 text-[13px] text-[#a1a1aa]">{value}</div>
    </div>
  );
}

/// An editor behind the browser, for depth. Lines as bars: text this small
/// is texture, and readable code would compete with the card.
function Editor() {
  const lines = [
    [0, 60, "#c792ea"], [0, 140, "#82aaff"], [1, 90, "#ffcb6b"], [1, 180, "#a6accd"], [2, 120, "#89ddff"],
    [2, 70, "#c3e88d"], [1, 40, "#a6accd"], [0, 20, "#a6accd"], [0, 100, "#c792ea"], [1, 160, "#82aaff"],
    [2, 110, "#c3e88d"], [2, 140, "#ffcb6b"], [3, 90, "#a6accd"], [2, 60, "#89ddff"], [1, 30, "#a6accd"],
    [1, 150, "#c792ea"], [2, 190, "#c3e88d"], [1, 40, "#a6accd"], [0, 20, "#a6accd"],
  ] as const;
  return (
    <div
      className="absolute overflow-hidden rounded-xl bg-[#141418] ring-1 ring-white/10"
      style={{ left: 700, top: 150, width: 440, height: 420, boxShadow: "0 30px 70px -20px rgba(0,0,0,.6)" }}
    >
      <div className="flex h-9 items-center gap-3 border-b border-white/[0.06] px-4">
        <TrafficLights />
        <span className="text-[12px] text-white/45">SignIn.tsx</span>
      </div>
      <div className="flex flex-col gap-[9px] px-5 pt-4">
        {lines.map(([indent, w, c], i) => (
          <div key={i} className="flex items-center gap-4">
            <span className="w-4 text-right text-[10px] text-white/20 tabular-nums">{i + 1}</span>
            <span className="h-[7px] rounded-full opacity-70" style={{ marginLeft: indent * 16, width: w, background: c }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function TrafficLights() {
  return (
    <span className="flex gap-2">
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
        <span key={c} className="size-3 rounded-full" style={{ background: c }} />
      ))}
    </span>
  );
}

/// Under the screen: the keys the story is pressing, the current one lit. It
/// is what turns a pretty loop into instructions.
type Step = { key: string; label: string; phases: Phase[]; still: Phase };
const STEPS: Step[] = [
  { key: "⌃", label: "Tap Control", phases: ["open"], still: "open" },
  { key: "⌃", label: "Tap again, talk", phases: ["listen1", "draw", "rest", "capture", "listen2", "transcribe"], still: "listen2" },
  { key: "⏎", label: "Send", phases: ["review", "sent"], still: "review" },
  { key: "✓", label: "The agent's done", phases: ["working", "done"], still: "done" },
];

/// Each step is a way in: picking one plays the story on from there, or shows
/// its still frame under reduced motion.
function Steps({ phase, onPick }: { phase: Phase; onPick: (step: Step) => void }) {
  return (
    <ol className="mx-auto mt-4 flex max-w-4xl flex-wrap items-center justify-center gap-x-2 gap-y-2 px-3 text-sm">
      {STEPS.map((st) => {
        const on = st.phases.includes(phase);
        return (
          <li key={st.label}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onPick(st)}
              className={`flex cursor-pointer items-center gap-2 rounded-full border py-1 pr-3.5 pl-1 transition-all duration-300 outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                on
                  ? "border-white/20 bg-gradient-to-b from-white/[0.17] to-white/[0.04] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/.35),inset_0_-1px_0_rgb(255_255_255/.08),0_10px_28px_-10px_rgb(0_0_0/.7)] backdrop-blur-xl"
                  : "border-transparent text-muted-foreground/60 hover:border-white/10 hover:bg-white/[0.05] hover:text-foreground"
              }`}
            >
              <kbd
                className={`grid size-6 place-items-center rounded-full font-sans text-[13px] transition-colors duration-300 ${
                  on
                    ? "bg-gradient-to-b from-white to-white/75 text-background shadow-[inset_0_-1px_1px_rgb(0_0_0/.18),0_1px_3px_rgb(0_0_0/.45)]"
                    : "bg-white/[0.06] shadow-[inset_0_1px_0_rgb(255_255_255/.12)]"
                }`}
              >
                {st.key}
              </kbd>
              {st.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
