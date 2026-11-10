import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import { Warning } from "@/components/BoatWarnings";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import type { ServerInfo } from "@/types/events";
import "../App.css";

/// The boat sandbox warning card in each state, on made-up servers, each in a
/// column the default sidebar's width so a layout that does not fit shows. The
/// clock is real, counting from page load. Extend has no app behind it here,
/// so pressing it shows the refusal state for real.
const SIDEBAR = 240;

const server = (name: string): ServerInfo => ({
  id: name,
  name,
  named: true,
  url: "",
  ssh: `ssh ${name}`,
  on: true,
  status: "connected",
  stage: null,
  error: null,
  fix: null,
  release: null,
  beta: false,
  latest: null,
  app: false,
  restarting: false,
  boat: { phase: "running", stopsAt: null, warning: true, note: null },
});

const CASES: { title: string; name: string; seconds: number; refused?: string }[] = [
  { title: "Nine minutes left", name: "boat-dray", seconds: 9 * 60 + 12 },
  { title: "Last two minutes, red", name: "boat-dray", seconds: 95 },
  { title: "Long server name", name: "a-sandbox-with-a-very-long-name", seconds: 7 * 60 },
  { title: "Extend refused", name: "boat-dray", seconds: 6 * 60, refused: "Free trial sandboxes stop within 2 hours." },
];

function Demo() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6 p-10">
        <h1 className="text-lg font-medium">Boat sandbox warning</h1>
        <div className="flex flex-wrap gap-8">
          {CASES.map((c) => (
            <div key={c.title} className="flex flex-col gap-2">
              <span className="text-xs text-muted-foreground">{c.title}</span>
              {/* The sidebar's width, its rows' inset either side. */}
              <div className="rounded-lg bg-sidebar p-2" style={{ width: SIDEBAR }}>
                <Warning
                  server={server(c.name)}
                  stopsAt={new Date(start + c.seconds * 1000).toISOString()}
                  now={now}
                  autoFailed={c.refused}
                  onDismiss={() => {}}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      <DemoThemeBar />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
