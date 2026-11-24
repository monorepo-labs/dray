import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Blobatar } from "@blobatar/react";
import { idle, surprised } from "blobatar/expression";
import "blobatar/motion.css";

import { GATE_MARK, GateTiles } from "@/components/SignInGate";
import { avatarProps, seededAvatar } from "@/lib/botAvatar";
import { playWelcome } from "@/lib/sound";
import type { Bot } from "@/types/events";

import type { Variant } from "./state";
import "./onboarding.css";

/// Onboarding's first screen: one of three openings, then the same headline and
/// button. Each plays the welcome chime as its moment lands.
export default function Welcome({ variant, bot, onNext }: { variant: Variant; bot: Bot | undefined; onNext: () => void }) {
  const opening = OPENINGS[variant];
  useEffect(() => {
    const timer = setTimeout(playWelcome, opening.chimeAt);
    return () => clearTimeout(timer);
  }, [opening]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Enter" && onNext();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNext]);

  return (
    <>
      <div className="ob-rise pointer-events-none absolute inset-x-0 bottom-0 h-[300px]" style={delay(opening.tilesAt)}>
        <GateTiles />
      </div>
      <main className="relative flex flex-1 flex-col items-center justify-center pb-24">
        {variant === "arrive" && <Arrive bot={bot} />}
        {variant === "tiles" && <TileMark />}
        {variant === "wordmark" ? (
          <Wordmark />
        ) : (
          <h1 className="ob-in mt-10 text-[52px] leading-[60px] font-light tracking-[-0.035em] text-white" style={delay(opening.textAt)}>
            Welcome to Dray
          </h1>
        )}
        <p className="ob-in mt-3 text-[17px] leading-6 text-white/50" style={delay(opening.textAt + 200)}>
          Let's get you set up.
        </p>
        <div className="ob-in mt-10" style={delay(opening.textAt + 500)}>
          <PrimaryButton onClick={onNext}>Get started</PrimaryButton>
        </div>
      </main>
    </>
  );
}

/// When, in ms, each opening lands its chime, tiles and text.
const OPENINGS: Record<Variant, { chimeAt: number; tilesAt: number; textAt: number }> = {
  arrive: { chimeAt: 820, tilesAt: 900, textAt: 1300 },
  tiles: { chimeAt: 1500, tilesAt: 1700, textAt: 1800 },
  wordmark: { chimeAt: 1000, tilesAt: 1500, textAt: 1600 },
};

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

/// A: Dray Bot drops in, squashes on landing, and smiles.
function Arrive({ bot }: { bot: Bot | undefined }) {
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLanded(true), 950);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="relative flex flex-col items-center">
      <div className="ob-drop" style={delay(300)}>
        <Mascot bot={bot} expression={landed ? idle : surprised} className="size-36" />
      </div>
      <div
        aria-hidden
        className="ob-shadow -mt-3 h-4 w-28 rounded-[50%] bg-white/10 blur-md"
        style={delay(300)}
      />
    </div>
  );
}

/// The bot's face, wearing `expression` and always in motion.
function Mascot({
  bot,
  expression,
  className,
}: {
  bot: Bot | undefined;
  expression?: typeof idle;
  className?: string;
}) {
  const seed = bot?.id ?? "dray";
  return (
    <Blobatar
      name={seed}
      aria-hidden
      expression={expression}
      animate="always"
      {...avatarProps(bot?.avatar ?? seededAvatar(seed))}
      className={className}
    />
  );
}

/// B: striped tiles fly in from every side and settle into the Dray mark.
function TileMark() {
  const cells = MARK_CELLS;
  return (
    <svg viewBox="0 0 159 200" width="128" height="161" className="ob-flash overflow-visible" style={delay(1450)} aria-hidden>
      <defs>
        <clipPath id="ob-mark">
          <path d={GATE_MARK} />
        </clipPath>
        <pattern id="ob-stripes" width="6" height="20" patternUnits="userSpaceOnUse">
          <rect width="2" height="20" fill="#00000026" />
        </pattern>
      </defs>
      {cells.map((c) => (
        // The clip sits inside the moving group, so each tile carries its own
        // piece of the mark in from off screen rather than appearing in place.
        <g key={`${c.x},${c.y}`} className="ob-fly" style={{ ...c.style, ...delay(c.at) }}>
          <g clipPath="url(#ob-mark)">
            <rect x={c.x} y={c.y} width={CELL - 1.5} height={CELL - 1.5} fill="#F2F2F2" />
            <rect x={c.x} y={c.y} width={CELL - 1.5} height={CELL - 1.5} fill="url(#ob-stripes)" />
          </g>
        </g>
      ))}
    </svg>
  );
}

const CELL = 20;
/// The grid the mark is cut from, each cell given where it flies in from.
/// Seeded, so the flight is the same on every replay.
const MARK_CELLS = (() => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const out: { x: number; y: number; at: number; style: CSSProperties }[] = [];
  for (let y = 0; y < 200; y += CELL)
    for (let x = 0; x < 160; x += CELL) {
      const angle = rand() * Math.PI * 2;
      const far = 260 + rand() * 260;
      out.push({
        x,
        y,
        at: 100 + rand() * 900,
        style: {
          "--dx": `${Math.cos(angle) * far}px`,
          "--dy": `${Math.sin(angle) * far}px`,
          "--r": `${(rand() - 0.5) * 240}deg`,
        } as CSSProperties,
      });
    }
  return out;
})();

/// C: the headline itself is the moment, each letter sharpening into place.
function Wordmark() {
  const words = ["Welcome", "to", "Dray"];
  let i = 0;
  return (
    <h1 className="text-[72px] leading-[80px] font-light tracking-[-0.04em] text-white">
      {words.map((word, w) => (
        <span key={word}>
          {[...word].map((ch) => (
            <span key={i} className={w === 2 ? "ob-letter ob-lit" : "ob-letter"} style={delay(200 + i++ * 55)}>
              {ch}
            </span>
          ))}
          {w < 2 && " "}
        </span>
      ))}
    </h1>
  );
}

/// The site's filled button: square, white on black.
export function PrimaryButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-12 cursor-pointer bg-white px-7 text-[15px] font-medium tracking-[-0.01em] text-black outline-none transition-colors hover:bg-white/85 focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/// A quiet text button for Back and Skip.
export function QuietButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-12 cursor-pointer px-4 text-[15px] text-white/50 outline-none transition-colors hover:text-white/80 focus-visible:text-white"
    >
      {children}
    </button>
  );
}
