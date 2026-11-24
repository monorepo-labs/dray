import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";

import { GATE_MARK, GateTiles } from "@/components/SignInGate";

import { useWelcomeSound } from "./state";
import { playWelcomeSound } from "./welcomeSounds";
import "./onboarding.css";

/// When, in ms, each beat of the welcome lands.
const SHINE_AT = 700;
const TEXT_AT = 1500;
const NEXT_AT = 3800;

const MARK_SVG = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 159 200'><path d='${GATE_MARK}'/></svg>`,
)}")`;
const MASK: CSSProperties = {
  maskImage: MARK_SVG,
  WebkitMaskImage: MARK_SVG,
  maskSize: "contain",
  WebkitMaskSize: "contain",
  maskRepeat: "no-repeat",
  WebkitMaskRepeat: "no-repeat",
};

/// Onboarding's first screen: the Dray mark, a light passing over it, then the
/// welcome, and on to setup by itself.
export default function Welcome({ onNext }: { onNext: () => void }) {
  const sound = useWelcomeSound();
  const next = useRef(onNext);
  next.current = onNext;

  useEffect(() => {
    // A tick late, so a mount React throws away at once never plays.
    const play = setTimeout(() => playWelcomeSound(sound, SHINE_AT + 250), 0);
    const advance = setTimeout(() => next.current(), NEXT_AT);
    return () => {
      clearTimeout(play);
      clearTimeout(advance);
    };
    // Once per showing; a sound picked mid-welcome waits for the next replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="ob-rise pointer-events-none absolute inset-x-0 bottom-0 h-[300px]" style={delay(TEXT_AT)}>
        <GateTiles />
      </div>
      <main className="relative flex flex-1 flex-col items-center justify-center pb-24">
        <div className="ob-in relative" style={delay(150)}>
          <div aria-hidden className="ob-halo absolute -inset-10 rounded-full bg-white/25 blur-2xl" style={delay(SHINE_AT)} />
          <div className="relative h-10 w-8 overflow-hidden" style={MASK}>
            <div className="ob-settle absolute inset-0 bg-white" style={delay(SHINE_AT + 500)} />
            <div className="ob-shine absolute inset-y-0 -left-full w-[300%]" style={delay(SHINE_AT)} />
          </div>
        </div>
        <h1 className="ob-in mt-8 text-[44px] leading-[52px] font-light tracking-[-0.03em] text-white" style={delay(TEXT_AT)}>
          Welcome to Dray
        </h1>
      </main>
    </>
  );
}

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

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
