import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Bot } from "@/types/events";

import { AgentList, type AgentSetup } from "./agents";
import { STARTERS } from "./state";

type Stop = { target: string; side: "right" | "top"; title: string; body: ReactNode };

const PAD = 6;
const GAP = 12;
const WIDTH = 320;

/// Variation D: the app as it is, with three coach marks over the real bot
/// row, agent picker and composer. Elements carry `data-tour` for it.
export default function Tour({
  setup,
  bot,
  onMore,
  onSay,
  onDone,
}: {
  setup: AgentSetup;
  bot: Bot | undefined;
  onMore: () => void;
  onSay: (text: string) => void;
  onDone: () => void;
}) {
  const name = bot?.name ?? "Dray Bot";
  const stops: Stop[] = [
    {
      target: "bot",
      side: "right",
      title: `This is ${name}`,
      body: "Tell it what you want done. It starts tasks in your projects and keeps track of them.",
    },
    {
      target: "agent",
      side: "top",
      title: "Pick an agent",
      body: (
        <>
          <p>It does the work. One is enough to start.</p>
          <AgentList setup={setup} onMore={onMore} className="mt-1.5 -mb-1" />
        </>
      ),
    },
    {
      target: "composer",
      side: "top",
      title: `Say hi to ${name}`,
      body: (
        <div className="flex flex-col items-start gap-1 pt-0.5">
          {STARTERS.map((text) => (
            <Button
              key={text}
              variant="outline"
              size="sm"
              disabled={setup.ready.length === 0}
              className="max-w-full justify-start truncate"
              onClick={() => onSay(text)}
            >
              {text}
            </Button>
          ))}
        </div>
      ),
    },
  ];
  const [at, setAt] = useState(0);
  const stop = stops[at];
  const rect = useRect(`[data-tour="${stop.target}"]`);

  const spot = rect && {
    left: rect.left - PAD,
    top: rect.top - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };
  const card: CSSProperties = !spot
    ? { left: "50%", top: "50%", transform: "translate(-50%, -50%)" }
    : stop.side === "right"
      ? { left: spot.left + spot.width + GAP, top: Math.max(12, spot.top) }
      : {
          left: Math.min(Math.max(12, spot.left), window.innerWidth - WIDTH - 12),
          bottom: window.innerHeight - spot.top + GAP,
        };

  return (
    <>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none fixed z-40 rounded-xl transition-all duration-300 ease-out",
          !spot && "inset-0 bg-black/30",
        )}
        style={spot ? { ...spot, boxShadow: "0 0 0 200vmax rgb(0 0 0 / 0.3)" } : undefined}
      />
      <div
        role="dialog"
        aria-label={stop.title}
        key={at}
        style={{ ...card, width: WIDTH }}
        className="fixed z-50 flex flex-col gap-1 rounded-xl bg-popover p-3 text-popover-foreground shadow-(--shadow-ring) backdrop-blur-xl animate-in fade-in zoom-in-95"
      >
        <span className="font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
          {at + 1} of {stops.length}
        </span>
        <span className="text-ui font-medium">{stop.title}</span>
        <div className="text-ui text-muted-foreground">{stop.body}</div>
        <div className="mt-2 flex items-center gap-1.5">
          <Button variant="ghost" size="sm" className="mr-auto text-muted-foreground" onClick={onDone}>
            Skip tour
          </Button>
          {at > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setAt(at - 1)}>
              Back
            </Button>
          )}
          <Button size="sm" onClick={() => (at === stops.length - 1 ? onDone() : setAt(at + 1))}>
            {at === stops.length - 1 ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </>
  );
}

/// Where `selector` sits on screen, followed every frame while the tour is up,
/// since the sidebar and composer move under it.
function useRect(selector: string): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    let frame = 0;
    let last = "";
    const tick = () => {
      const el = document.querySelector(selector);
      const next = el?.getBoundingClientRect() ?? null;
      const key = next ? `${next.left},${next.top},${next.width},${next.height}` : "";
      if (key !== last) {
        last = key;
        setRect(next && next.width > 0 ? next : null);
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [selector]);
  return rect;
}
