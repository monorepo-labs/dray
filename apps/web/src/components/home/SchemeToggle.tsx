"use client";

import { posthog } from "@/lib/posthog";

import { SCHEME_KEY } from "./scheme";

// Rays 7° apart. They meet below the cell, so where they would bunch
// into a dark knot is clipped away and only the fan shows.
const RAYS = Array.from({ length: 25 }, (_, i) => {
  const a = ((i - 12) * 7 * Math.PI) / 180;
  return `M20 64L${(20 + 90 * Math.sin(a)).toFixed(2)} ${(64 - 90 * Math.cos(a)).toFixed(2)}`;
}).join("");

/// Flips the homepage between light and dark and remembers the pick. CSS
/// colours the tile, so the server render is never wrong about which.
export function SchemeToggle({ className }: { className?: string }) {
  const flip = () => {
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
        className="absolute inset-0 size-full bg-[#FFE14D] transition-opacity group-hover:opacity-85 light:bg-[#C4C4C4]"
      >
        <path d={RAYS} stroke="#00000038" strokeWidth="2" />
      </svg>
    </button>
  );
}
