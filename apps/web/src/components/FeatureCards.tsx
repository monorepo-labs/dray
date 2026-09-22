import { BrowserCard } from "@/components/illustrations/cards/BrowserCard";
import { DictateCard } from "@/components/illustrations/cards/DictateCard";
import { IssueCard } from "@/components/illustrations/cards/IssueCard";
import { PrCard } from "@/components/illustrations/cards/PrCard";
import { ScaledWindow } from "@/components/illustrations/ScaledWindow";
import type { Feature } from "@/lib/features";

/// A card's drawing is a fragment of the app at its real size — a panel's
/// rows, the composer — not a whole window, so the frame is the card's own.
/// 556 is half the shell less the gap, the width one card gets on a desktop.
const WIDTH = 556;

/// Each scene at the height it needs. Every one sits at the card's foot: a
/// panel runs to the edge and is clipped there, so it reads as the app
/// continuing under the card, and a composer sits where a composer sits —
/// centred in the card it floated, belonging to nothing.
const SCENES: Record<string, { Scene: React.ComponentType; height: number }> = {
  "pull-requests": { Scene: PrCard, height: 300 },
  browser: { Scene: BrowserCard, height: 300 },
  linear: { Scene: IssueCard, height: 208 },
  dictation: { Scene: DictateCard, height: 80 },
};

/// The smaller features, two to a row. Each card is a headline, one line,
/// and a fragment of the app doing the thing — the big sections above draw
/// the whole window because their subject is the window; these are one
/// panel or one control, and a full window around that is mostly empty.
export function FeatureCards({ features, className }: { features: Feature[]; className?: string }) {
  return (
    <div className={`grid gap-4 sm:grid-cols-2 ${className ?? ""}`}>
      {features.map((f) => {
        const scene = SCENES[f.id];
        return (
          <article
            key={f.id}
            id={f.id}
            className="flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-window"
          >
            <div className="p-6 pb-4">
              <p className="mb-2 font-mono text-sm text-muted-foreground">{f.label}</p>
              <h3 className="font-display text-2xl leading-[1.1] font-medium tracking-tight text-balance">
                {f.title}
              </h3>
              <p className="mt-2 text-base text-muted-foreground text-pretty">{f.line}</p>
            </div>
            {/* The trackers, under the text rather than centred in the room
                below it: the issue picker rises out of the scene into that
                room, and marks floated there sat under its rows. */}
            {f.marks && (
              <div className="flex items-center gap-6 px-6 pb-6 text-muted-foreground">
                {f.marks.map((Mark, i) => (
                  <Mark key={i} className="size-9" />
                ))}
              </div>
            )}
            {scene && (
              <ScaledWindow width={WIDTH} height={scene.height} className="mt-auto">
                <div className="h-full w-full">
                  <scene.Scene />
                </div>
              </ScaledWindow>
            )}
          </article>
        );
      })}
    </div>
  );
}
