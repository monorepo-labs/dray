import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import WhatsNewCard from "@/components/WhatsNewCard";
import WhatsNewDialog from "@/components/WhatsNewDialog";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { HIGHLIGHTS, RELEASE } from "@/demo/whatsNewData";
import "../App.css";

/// The what's-new dialog over its highlights, and the small card a release
/// without any still gets. An action logs what it would have done instead of
/// doing it.

function Demo() {
  const [open, setOpen] = useState<"dialog" | "card" | null>("dialog");
  const [log, setLog] = useState<string[]>([]);
  const say = (line: string) => setLog((all) => [...all, line]);

  return (
    <TooltipProvider>
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-10">
        <h1 className="text-lg font-medium">What's new</h1>
        <p className="text-ui text-muted-foreground">
          Three highlights: the first with an action, the last with no media. Arrow keys walk the pages; Enter
          is Next.
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setOpen("dialog")}>
            Open the dialog
          </Button>
          <Button size="sm" variant="outline" onClick={() => setOpen("card")}>
            Show the small card
          </Button>
        </div>
        <ul className="font-mono text-xs text-muted-foreground">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>
      {open === "dialog" && (
        <WhatsNewDialog
          highlights={HIGHLIGHTS}
          actionFor={(target) => () => say(`action → ${target}`)}
          onClose={() => {
            say("closed, seen");
            setOpen(null);
          }}
        />
      )}
      {open === "card" && <WhatsNewCard release={RELEASE} onDismiss={() => setOpen(null)} onView={() => setOpen(null)} />}
      <DemoThemeBar />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
