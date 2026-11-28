import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import WhatsNewCard from "@/components/WhatsNewCard";
import WhatsNewPage from "@/components/WhatsNewPage";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { HIGHLIGHTS, NEXT_RELEASE, onWhite, RELEASE } from "@/demo/whatsNewData";
import "../App.css";

/// What's New over its highlights, as the app raises it, and the small card a
/// release without any still gets. An action logs what it would have done
/// instead of doing it.
///
/// Two sets: the next release's own three, on the white-tile pictures drawn for
/// white cards, and three samples (an action, a picture from the site, no
/// media) for an odd count.

const SETS = {
  next: NEXT_RELEASE.map(onWhite),
  three: HIGHLIGHTS,
};

function Demo() {
  const [open, setOpen] = useState<"next" | "three" | "card" | null>("next");
  const [log, setLog] = useState<string[]>([]);
  const say = (line: string) => setLog((all) => [...all, line]);

  return (
    <TooltipProvider>
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-10">
        <h1 className="text-lg font-medium">What's new</h1>
        <p className="text-ui text-muted-foreground">
          The full-window page over a release's highlights. Continue or Escape leaves; an action leaves too.
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setOpen("next")}>
            Next release (2)
          </Button>
          <Button size="sm" variant="outline" onClick={() => setOpen("three")}>
            Three highlights
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
      {(open === "next" || open === "three") && (
        <WhatsNewPage
          highlights={SETS[open]}
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
