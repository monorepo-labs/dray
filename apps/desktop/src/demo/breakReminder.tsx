import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import BreakOverlay, { BreakCard } from "@/components/BreakOverlay";
import { BREAK_CARDS } from "@/components/breakScenes";
import { BreakRows } from "@/components/SettingsPage";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { setBreakDue, useBreakSettings } from "@/lib/breaks";
import "../App.css";

/// Samples every big card's drawing for six seconds and reports how far each
/// reaches, in the drawings' own units: the box is 0 0 160 110 and a stroke
/// overhangs its path by about 2. Anything past the box is cut off.
function checkFraming(report: (s: string) => void) {
  const svgs = [...document.querySelectorAll<SVGSVGElement>("figure svg")];
  const ext = svgs.map(() => [Infinity, Infinity, -Infinity, -Infinity]);
  const end = performance.now() + 6000;
  requestAnimationFrame(function tick() {
    svgs.forEach((svg, i) => {
      const b = svg.getBBox();
      const e = ext[i];
      ext[i] = [Math.min(e[0], b.x), Math.min(e[1], b.y), Math.max(e[2], b.x + b.width), Math.max(e[3], b.y + b.height)];
    });
    if (performance.now() < end) return requestAnimationFrame(tick);
    report(
      BREAK_CARDS.map(({ name }, i) => {
        const [x0, y0, x1, y1] = ext[i].map((v) => Math.round(v));
        const cut = x0 < 2 || y0 < 2 || x1 > 158 || y1 > 108;
        return `${cut ? "CUT" : "ok "} ${name}: x ${x0}..${x1}, y ${y0}..${y1}`;
      }).join("\n"),
    );
  });
}

/// Every card, across palettes, beside Settings' own break rows, so the picker
/// can be tried against what it picks from. Show break raises the real overlay.
function Demo() {
  const { off } = useBreakSettings();
  const [framing, setFraming] = useState("");
  return (
    <div className="flex flex-col gap-10 p-8 pb-48">
      <div className="flex items-center gap-4">
        <DemoThemeBar />
        <Button variant="outline" onClick={() => setBreakDue(true)}>
          Show break
        </Button>
        <Button variant="outline" onClick={() => checkFraming(setFraming)}>
          Check framing
        </Button>
      </div>
      {framing && <pre className="font-mono text-xs">{framing}</pre>}
      <section className="flex max-w-xl flex-col gap-4 rounded-xl border border-border p-5">
        <BreakRows />
      </section>
      <div className="flex flex-wrap gap-10">
        {BREAK_CARDS.map(({ name, text, Scene }) => (
          <figure key={name} className={`flex flex-col items-center gap-3 ${off.includes(name) ? "opacity-40" : ""}`}>
            <BreakCard text={text} Scene={Scene} />
            <figcaption className="text-sm text-muted-foreground">
              {name}
              {off.includes(name) && " (off)"}
            </figcaption>
          </figure>
        ))}
      </div>
      <BreakOverlay />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider>
      <Demo />
    </TooltipProvider>
  </React.StrictMode>,
);
