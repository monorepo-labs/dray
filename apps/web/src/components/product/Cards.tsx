import { BrowserCard } from "@/components/illustrations/cards/BrowserCard";
import { DictateCard } from "@/components/illustrations/cards/DictateCard";
import { IssueCard } from "@/components/illustrations/cards/IssueCard";
import { PrCard } from "@/components/illustrations/cards/PrCard";
import { ScaledWindow } from "@/components/illustrations/ScaledWindow";
import type { Feature } from "@/lib/features";
import { CARD_BG } from "./Stage";

/// Each card's fragment of the app at its real size. `float` is the composer,
/// which floats mid-stage; the rest are panels rising from its foot, so they
/// read as the app continuing under the card.
const SCENES: Record<string, { Scene: React.ComponentType; height: number; float?: boolean }> = {
  "pull-requests": { Scene: PrCard, height: 300 },
  linear: { Scene: IssueCard, height: 208 },
  dictation: { Scene: DictateCard, height: 60, float: true },
  browser: { Scene: BrowserCard, height: 300 },
};

/// The smaller features, two to a row: a fragment of the app on the page's
/// backdrop, then what it is.
export function Cards({ features, className = "" }: { features: Feature[]; className?: string }) {
  return (
    <div className={`grid gap-4 sm:grid-cols-2 ${className}`}>
      {features.map((f, i) => {
        const scene = SCENES[f.id];
        return (
          <article key={f.id} id={f.id} className="overflow-hidden rounded-2xl border-[0.5px] border-white/[0.03] bg-white/[0.1]">
            <div
              aria-hidden
              className="relative h-64 overflow-hidden"
              style={CARD_BG}
            >
              {scene && (
                <div
                  className={`absolute inset-x-5 overflow-hidden bg-background shadow-window ring-1 ring-white/10 sm:inset-x-8 ${
                    scene.float ? "top-1/2 -translate-y-1/2 rounded-xl" : "bottom-0 rounded-t-xl"
                  }`}
                >
                  <ScaledWindow width={556} height={scene.height}>
                    {/* The composer floats in a frame of its own already, so
                        its card is dropped: one box, the frame's darker one. */}
                    <div
                      className={`h-full w-full ${
                        scene.float
                          ? "grid items-center [&_.bg-composer]:border-transparent [&_.bg-composer]:bg-transparent [&_.bg-composer]:backdrop-blur-none [&>div]:p-0 [&>div>div]:p-0"
                          : "pt-3"
                      }`}
                    >
                      <scene.Scene />
                    </div>
                  </ScaledWindow>
                </div>
              )}
            </div>
            <div className="px-5 py-4">
              <div className="flex items-center gap-2">
                <h3 className="font-medium">{f.title}</h3>
                {f.marks && (
                  <span className="ml-auto flex items-center gap-2 text-muted-foreground">
                    {f.marks.map((Mark, k) => (
                      <Mark key={k} className="size-4" />
                    ))}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground text-pretty">{f.line}</p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
