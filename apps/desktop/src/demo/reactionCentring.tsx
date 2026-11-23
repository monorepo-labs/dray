import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";

import { ReactionBadge } from "@/components/chat/Reactions";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { setMode, setTheme } from "@/hooks/useTheme";
import { REACTIONS } from "@/lib/reactions";
import { THEMES } from "@/lib/theme";
import "../App.css";

/// Whether every reaction sits at the centre of its badge by eye. Each emoji is
/// drawn twice, at the badge's real size and blown up, once as the box puts it
/// ("raw") and once as the real `ReactionBadge` does, plain as the app draws
/// them, with the nudge read out under each. Judge it in the browser whose
/// emoji font is in question: Safari or the app for Apple's, the session
/// browser or Android's for Noto.

const RAW =
  "flex size-8 items-center justify-center rounded-full border border-border bg-(--reaction) text-[14px] shadow-[0_0_0_3px_var(--reaction)] leading-none select-none";

/// The nudge the badge beside it applied, read off its glyph once it settled.
function Readout({ at }: { at: React.RefObject<HTMLDivElement | null> }) {
  const [text, setText] = useState("…");
  useEffect(() => {
    const t = setTimeout(() => {
      const glyph = at.current?.querySelector<HTMLElement>("[role=img] > span");
      const moved = glyph?.style.transform.match(/-?[\d.]+(?:e-?\d+)?/g)?.map((n) => Number(n).toFixed(2));
      setText(moved ? `→ ${moved[0]} ↓ ${moved[1]}` : "none");
    }, 300);
    return () => clearTimeout(t);
  }, [at]);
  return <p className="text-center text-[12px] text-muted-foreground tabular-nums">{text}</p>;
}

function Blown({ emoji, raw }: { emoji: string; raw: boolean }) {
  const at = useRef<HTMLDivElement>(null);
  return (
    <div className="flex flex-col gap-2">
      <div ref={at} className="relative size-32">
        <div className="relative size-8 origin-top-left scale-400">
          {raw ? <span className={RAW}>{emoji}</span> : <ReactionBadge emoji={emoji} />}
        </div>
      </div>
      {!raw && <Readout at={at} />}
    </div>
  );
}

function Row({ label, raw }: { label: string; raw: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <div className="flex gap-6">
        {REACTIONS.map((emoji) => (
          <div key={emoji} className="relative size-8">
            {raw ? <span className={RAW}>{emoji}</span> : <ReactionBadge emoji={emoji} />}
          </div>
        ))}
      </div>
      {/* Blown up by a transform, which leaves layout and so the measuring alone. */}
      <div className="flex gap-2 pt-2">
        {REACTIONS.map((emoji) => (
          <Blown key={emoji} emoji={emoji} raw={raw} />
        ))}
      </div>
    </div>
  );
}

function Demo() {
  return (
    <main className="flex flex-col gap-10 py-8 pr-8 pl-56 text-foreground">
      <Row label="Raw: the emoji's box centred, as the badge drew it before" raw />
      <Row label="ReactionBadge: centred by its ink" raw={false} />
    </main>
  );
}

// `?mode=light&theme=default` opens on that pick, for a screenshot taken without a click.
const query = new URLSearchParams(location.search);
const mode = query.get("mode");
if (mode === "light" || mode === "dark") setMode(mode);
const theme = THEMES.find((t) => t.id === query.get("theme"));
if (theme) setTheme(theme.id);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider>
      <Demo />
      <DemoThemeBar />
    </TooltipProvider>
  </React.StrictMode>,
);
