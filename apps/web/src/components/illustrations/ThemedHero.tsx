"use client";

import { useEffect, useState } from "react";

/// The app's themes, ids as App.css spells them. The palettes live in
/// globals.css under `[data-proto-theme]`; this is the list the picker
/// draws, in the order the app's own settings list them.
const THEMES = [
  { id: "default", label: "Dray" },
  { id: "catppuccin", label: "Catppuccin" },
  { id: "cobalt2", label: "Cobalt2" },
  { id: "one-dark-pro", label: "One Dark Pro" },
  { id: "gruvbox", label: "Gruvbox" },
];

const CYCLE_MS = 2000;

/// The hero window with the app's theme picker sitting on its top edge: a
/// row of unlabelled blocks the title column's width, one per theme, butted
/// together. Each is its theme's card colour, brightened — the palettes are all
/// near-black on a near-black page, and lifting the fill keeps the hue that
/// tells them apart. The picked one is drawn full and a touch taller; the rest
/// sit dimmed and rise on hover. Left alone the row walks itself every two
/// seconds so the window shows every palette; a click stops the walk, since
/// a reader who picked one wants to look at it. The window itself is passed
/// in, so it stays a server component.
export function ThemedHero({ children, className }: { children: React.ReactNode; className?: string }) {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState(false);

  useEffect(() => {
    if (picked) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % THEMES.length), CYCLE_MS);
    return () => clearInterval(id);
  }, [picked]);

  const theme = THEMES[index];

  return (
    <div className={className}>
      <div role="radiogroup" aria-label="Theme" className="mx-auto flex h-4 w-full max-w-3xl items-end">
        {THEMES.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={i === index}
            aria-label={t.label}
            data-proto-theme={t.id}
            onClick={() => {
              setPicked(true);
              setIndex(i);
            }}
            className={`min-w-0 flex-1 bg-card brightness-[1.75] transition-[height,opacity] duration-300 ease-out hover:h-4 ${
              i === index ? "h-3" : "h-2 opacity-50 hover:opacity-100"
            }`}
          />
        ))}
      </div>
      <div data-proto-theme={theme.id} className="proto-window">
        {children}
      </div>
    </div>
  );
}
