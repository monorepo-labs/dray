import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import HandoffRow from "@/components/composer/HandoffRow";
import HandoffSettings from "@/components/settings/HandoffSettings";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { useHandoffButtons } from "@/hooks/useHandoffButtons";
import { handoffActions } from "@/lib/handoff";
import type { WorkStatus } from "@/types/events";
import "../App.css";

/// Settings → Composer beside the row it configures, at the two composer
/// widths that matter: full `max-w-3xl`, and ~415px with the right panel open.
/// Both read the real store, so an edit on the left moves the row at once.
/// Hover a row's top edge, or Tab into it, to open it.
const STATUS: WorkStatus = {
  dirty: 2,
  branch: "feature",
  upstream: "origin/feature",
  ahead: 0,
  defaultBranch: "main",
  aheadOfBase: 1,
};

function Composer({ width, dirty }: { width: number; dirty: boolean }) {
  const buttons = useHandoffButtons();
  const actions = handoffActions(dirty ? STATUS : { ...STATUS, dirty: 0, aheadOfBase: 0 }, false, true, buttons);
  return (
    <div style={{ width }} className="pt-10">
      <HandoffRow actions={actions} onSend={(p) => console.log("send", p)} />
      <div className="h-24 rounded-2xl border bg-(--surface-card) p-3 text-ui text-muted-foreground">
        Composer, {width}px
      </div>
    </div>
  );
}

function Demo() {
  const [dirty, setDirty] = useState(true);
  const [held, setHeld] = useState(false);
  return (
    <TooltipProvider>
      {/* Hover and focus are what open a row, and a screenshot keeps neither. */}
      {held && <style>{".group > .overflow-hidden { height: 2rem !important; }"}</style>}
      <div className="flex min-h-screen flex-col gap-8 p-8">
        <DemoThemeBar />
        <label className="flex items-center gap-2 text-ui">
          <input type="checkbox" checked={dirty} onChange={(e) => setDirty(e.target.checked)} />
          Uncommitted changes (Commit and Create PR earn their place)
        </label>
        <label className="flex items-center gap-2 text-ui">
          <input type="checkbox" checked={held} onChange={(e) => setHeld(e.target.checked)} />
          Hold the rows open
        </label>
        <div className="max-w-160">
          <HandoffSettings />
        </div>
        <Composer width={768} dirty={dirty} />
        <Composer width={415} dirty={dirty} />
      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
