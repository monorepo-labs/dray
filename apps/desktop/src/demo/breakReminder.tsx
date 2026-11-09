import React from "react";
import ReactDOM from "react-dom/client";

import BreakOverlay, { BreakCard } from "@/components/BreakOverlay";
import { BREAK_LINES } from "@/components/breakScenes";
import { Button } from "@/components/ui/button";
import DemoThemeBar from "@/demo/ThemeBar";
import { setBreakDue } from "@/lib/breaks";
import "../App.css";

/// Every line with every drawing tried for it, one row a line, so a pick can
/// be made across palettes. Show break raises the real overlay.
function Demo() {
  return (
    <div className="flex flex-col gap-10 p-8 pb-48">
      <div className="flex items-center gap-4">
        <DemoThemeBar />
        <Button variant="outline" onClick={() => setBreakDue(true)}>
          Show break
        </Button>
      </div>
      {BREAK_LINES.map((line) => (
        <section key={line.text} className="flex flex-col gap-4">
          <h2 className="font-medium">{line.text}</h2>
          <div className="flex flex-wrap gap-10">
            {line.scenes.map(({ name, Scene }) => (
              <figure key={name} className="flex flex-col items-center gap-3">
                <BreakCard text={line.text} Scene={Scene} />
                <figcaption className="text-sm text-muted-foreground">{name}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
      <BreakOverlay />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
