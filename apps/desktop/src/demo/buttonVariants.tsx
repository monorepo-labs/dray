import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";

import TabButton from "@/components/TabButton";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { useTheme } from "@/hooks/useTheme";
import "../App.css";

/// Every `Button` variant and size on the side panel's white sheet, each with
/// its resting fill measured live and its hover as worked out for Default light.
/// Asked while choosing what a selected side-panel tab should wear.
const VARIANTS = [
  { variant: "default", hover: "#3e3e3e", note: "--button-primary, hover 90%" },
  { variant: "secondary", hover: "#efefef", note: "--secondary + shadow-surface, hover +5% foreground" },
  { variant: "outline", hover: "#ededed", note: "--card + --border, hover --fill-soft" },
  { variant: "ghost", hover: "#ededed", note: "transparent, hover --fill-soft" },
  { variant: "destructive", hover: "#f5d4d5", note: "--destructive/10, hover /20" },
] as const;

const COLS = { gridTemplateColumns: "110px 1fr 110px 110px" };

const SIZES = ["xs", "sm", "default"] as const;
const ICON_SIZES = ["icon-xs", "icon-sm", "icon"] as const;

/// The colour an element's background composites to over the sheet, as hex.
function measure(el: HTMLElement, under: HTMLElement): string {
  const c = document.createElement("canvas").getContext("2d")!;
  c.fillStyle = "#fff";
  c.fillRect(0, 0, 1, 1);
  c.fillStyle = getComputedStyle(under).backgroundColor;
  c.fillRect(0, 0, 1, 1);
  c.fillStyle = getComputedStyle(el).backgroundColor;
  c.fillRect(0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function Swatch({ hex }: { hex: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[12px]">
      <span className="size-3 rounded-sm ring-1 ring-border" style={{ background: hex }} />
      {hex}
    </span>
  );
}

function Row({ variant, hover, note, sheet }: (typeof VARIANTS)[number] & { sheet: HTMLElement | null }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { theme, resolvedMode } = useTheme();
  const [rest, setRest] = useState("");
  useLayoutEffect(() => {
    if (ref.current && sheet) setRest(measure(ref.current, sheet));
  }, [sheet, theme, resolvedMode]);
  return (
    <div style={COLS} className="grid items-center gap-4 border-b border-border py-3 last:border-0">
      <span className="text-ui font-medium">{variant}</span>
      <div className="flex flex-wrap items-center gap-2">
        {SIZES.map((size) => (
          <Button key={size} ref={size === "default" ? ref : undefined} variant={variant} size={size}>
            {size}
          </Button>
        ))}
        {ICON_SIZES.map((size) => (
          <Button key={size} variant={variant} size={size} aria-label={size}>
            +
          </Button>
        ))}
        <span className="text-[12px] text-muted-foreground">{note}</span>
      </div>
      <Swatch hex={rest} />
      <Swatch hex={hover} />
    </div>
  );
}

function Demo() {
  const { setTheme, setMode } = useTheme();
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null);
  const [tab, setTab] = useState("Changes");
  useEffect(() => {
    // Asked about Default light; the bar switches from there.
    setTheme("default");
    setMode("light");
  }, [setTheme, setMode]);
  return (
    <TooltipProvider>
      <div className="min-h-screen p-8">
        <DemoThemeBar />
        <div ref={setSheet} className="mx-auto max-w-5xl rounded-[8px] bg-(--surface-sheet) p-6 shadow-(--shadow-sheet)">
          <h1 className="mb-1 text-chat font-semibold">Button variants</h1>
          <p className="mb-4 text-ui text-muted-foreground">
            On the side panel's white sheet. Rest is measured live; hover is Default light's, worked out from the tokens.
          </p>
          <div style={COLS} className="grid gap-4 pb-2 text-[12px] text-muted-foreground">
            <span>Variant</span>
            <span>Sizes: xs, sm, default, icon-xs, icon-sm, icon</span>
            <span>Rest</span>
            <span>Hover</span>
          </div>
          {VARIANTS.map((v) => (
            <Row key={v.variant} {...v} sheet={sheet} />
          ))}

          <h2 className="mt-8 mb-2 text-ui font-semibold">Side panel tabs today</h2>
          <div className="flex gap-0.5">
            {["Changes", "Files", "PR", "More"].map((t) => (
              <TabButton key={t} active={tab === t} onClick={() => setTab(t)}>
                {t}
              </TabButton>
            ))}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
