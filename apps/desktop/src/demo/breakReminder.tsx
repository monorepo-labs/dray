import React from "react";
import ReactDOM from "react-dom/client";

import BreakOverlay, { BreakCard } from "@/components/BreakOverlay";
import { BREAK_CARDS } from "@/components/breakScenes";
import { BreakRows } from "@/components/SettingsPage";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { setBreakDue, useBreakSettings } from "@/lib/breaks";
import "../App.css";

/// Every card, across palettes, beside Settings' own break rows, so the picker
/// can be tried against what it picks from. Show break raises the real overlay.
function Demo() {
  const { off } = useBreakSettings();
  return (
    <div className="flex flex-col gap-10 p-8 pb-48">
      <div className="flex items-center gap-4">
        <DemoThemeBar />
        <Button variant="outline" onClick={() => setBreakDue(true)}>
          Show break
        </Button>
      </div>
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
