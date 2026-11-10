"use client";

import { type CSSProperties, useRef } from "react";

import { posthog } from "@/lib/posthog";

import { SCHEME_KEY } from "./scheme";

// Rays 7° apart. They meet below the cell, so where they would bunch
// into a dark knot is clipped away and only the fan shows.
const RAY_PATHS = Array.from({ length: 25 }, (_, i) => {
  const a = ((i - 12) * 7 * Math.PI) / 180;
  return `M20 64L${(20 + 90 * Math.sin(a)).toFixed(2)} ${(64 - 90 * Math.cos(a)).toFixed(2)}`;
});
const RAYS = RAY_PATHS.join("");

/// Flips the homepage between light and dark and remembers the pick. CSS
/// colours the tile, so the server render is never wrong about which.
export function SchemeToggle({ className }: { className?: string }) {
  const fan = useRef<SVGGElement>(null);

  const flip = () => {
    // A 42° turn, six rays, ends on the picture it started from, so every
    // flip plays the same clockwise turn and the fan never has to come back.
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      fan.current?.animate([{ rotate: "0deg" }, { rotate: "42deg" }], {
        duration: 350,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
    }
    const root = document.documentElement;
    const to = root.dataset.scheme === "light" ? "dark" : "light";
    root.dataset.scheme = to;
    // Holds the pick for this visit even where storage refuses it.
    root.dataset.schemePicked = "1";
    try {
      localStorage.setItem(SCHEME_KEY, to);
    } catch {}
    posthog.capture("scheme_toggle", { to });
  };

  return (
    <button type="button" onClick={flip} className={`group relative ${className}`}>
      <span className="sr-only">Switch between light and dark</span>
      {/* Rays fanning up from the bottom edge, even in width end to end:
          yellow for the sun in dark, grey for the moon in light. */}
      <svg
        aria-hidden
        viewBox="0 0 40 40"
        className="absolute inset-0 size-full bg-[#FFE14D] motion-reduce:group-hover:brightness-110 light:bg-[#C4C4C4]"
      >
        <g ref={fan} className="origin-[20px_64px] [transform-box:view-box]">
          <path d={RAYS} stroke="#00000038" strokeWidth="2" />
          {/* Hover lights the rays one at a time, left to right, once. The
              tile shows rays 7–17, so the wave starts at 7. */}
          {RAY_PATHS.map((d, i) => (
            <path
              key={i}
              d={d}
              stroke="#FFFFFF"
              strokeWidth="2"
              style={{ "--i": i } as CSSProperties}
              className="opacity-0 [--shine:0.85] light:[--shine:0.4] group-hover:animate-[ray-shine_680ms_linear_calc((var(--i)_-_7)_*_40ms)] motion-reduce:group-hover:animate-none"
            />
          ))}
        </g>
      </svg>
    </button>
  );
}
