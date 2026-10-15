import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { burst, clickWheel, ping, playVoice, type Voice } from "@/lib/tick";
import "../App.css";

/// Which click the sidebar swipe makes as it steps past each project.
///
/// Every candidate plays alone, and as the run of clicks a drag past several
/// projects makes — a sound that is right once can still grate at the fourth.
/// Number keys play each one, so they can be compared without aiming. The
/// second round of the audition, all built on round one's pick; the first
/// round's picker, ratchet, dial, wood and tock lost to the click wheel.

/// Struck metal: a handful of high partials that are not a chord.
const ring = (c: BaseAudioContext, out: AudioNode, at: number, base: number, ratios: number[], gain: number, decay: number) =>
  ratios.forEach((r, i) => ping(c, out, at, "sine", base * r, base * r * 0.995, gain / (i + 1), decay / (1 + i * 0.4)));

const TICKS: { id: string; name: string; like: string; voice: Voice }[] = [
  { id: "wheel", name: "Click wheel", like: "the iPod's scroll wheel — the one the app plays", voice: clickWheel },
  {
    id: "steel",
    name: "Steel wheel",
    like: "the click wheel with a short steel ring",
    voice: (c, out, at) => {
      burst(c, out, at, "highpass", 5000, 0.8, 0.7, 0.005);
      ring(c, out, at, 4200, [1, 1.47, 2.09], 0.12, 0.03);
    },
  },
  {
    id: "latch",
    name: "Latch",
    like: "a small metal latch snapping shut",
    voice: (c, out, at) => {
      burst(c, out, at, "bandpass", 4500, 6, 0.9, 0.012);
      burst(c, out, at + 0.006, "bandpass", 5200, 6, 0.45, 0.01);
    },
  },
  {
    id: "spring",
    name: "Spring detent",
    like: "a sprung steel detent, rings a little longer",
    voice: (c, out, at) => {
      burst(c, out, at, "highpass", 4000, 0.8, 0.6, 0.006);
      ring(c, out, at, 3100, [1, 1.59, 2.31, 2.92], 0.16, 0.05);
    },
  },
  {
    id: "coin",
    name: "Coin edge",
    like: "a coin's edge tapped on a desk",
    voice: (c, out, at) => {
      burst(c, out, at, "highpass", 6000, 0.8, 0.5, 0.004);
      ring(c, out, at, 6400, [1, 1.33, 1.71], 0.1, 0.025);
    },
  },
  {
    id: "pin",
    name: "Pin",
    like: "a tiny pin dropping off a cog, drier still",
    voice: (c, out, at) => burst(c, out, at, "bandpass", 6500, 3, 0.9, 0.003),
  },
];

type Tick = (typeof TICKS)[number];

function run(tick: Tick, count: number, gap: number, volume: number) {
  for (let i = 0; i < count; i++) setTimeout(() => playVoice(tick.voice, volume), i * gap);
}

function Demo() {
  const [volume, setVolume] = useState(0.5);
  const [last, setLast] = useState<string | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tick = TICKS[Number(e.key) - 1];
      if (!tick) return;
      setLast(tick.id);
      playVoice(tick.voice, volume);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [volume]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-8 text-ui">
      <DemoThemeBar />
      <div>
        <h1 className="text-lg font-semibold">Swipe tick</h1>
        <p className="text-muted-foreground">
          Press a number key, or the buttons. "Slow drag" and "Fast drag" play the clicks a swipe past four
          projects would make.
        </p>
      </div>

      <label className="flex items-center gap-3">
        Volume
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
        />
        <span className="tabular-nums text-muted-foreground">{Math.round(volume * 100)}%</span>
      </label>

      <ul className="flex flex-col gap-2">
        {TICKS.map((tick, i) => (
          <li
            key={tick.id}
            className={`flex items-center gap-3 rounded-lg border p-3 ${last === tick.id ? "border-foreground/40" : "border-border"}`}
          >
            <span className="w-4 text-muted-foreground tabular-nums">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{tick.name}</div>
              <div className="text-muted-foreground">Like {tick.like}</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLast(tick.id);
                playVoice(tick.voice, volume);
              }}
            >
              Once
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLast(tick.id);
                run(tick, 4, 180, volume);
              }}
            >
              Slow drag
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLast(tick.id);
                run(tick, 4, 70, volume);
              }}
            >
              Fast drag
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TooltipProvider>
      <Demo />
    </TooltipProvider>
  </React.StrictMode>,
);
