import { FeatureCards } from "@/components/FeatureCards";
import { LazyVideo } from "@/components/LazyVideo";
import { Orchestration } from "@/components/illustrations/Orchestration";
import { SplitView } from "@/components/illustrations/SplitView";
import { FEATURES } from "@/lib/features";

/// Which feature has an illustration of its own. One without falls back to
/// its capture, so the page never draws an empty frame while the set is
/// being built out.
const ILLUSTRATIONS: Record<string, React.ComponentType<{ className?: string }>> = {
  orchestration: Orchestration,
  "split-view": SplitView,
};

/// The text column, the page's own 3xl. The section itself runs the shell's
/// full width, so the drawing can — a window only reads at the width the
/// hero capture gets — and the words stay where every other sentence sits.
const COLUMN = "mx-auto w-full max-w-3xl";

/// One section per feature: the headline, one line under it, the drawing.
/// Then the smaller features as a grid of cards.
///
/// The headline is the whole pitch — nobody reads past it — so it takes the
/// display face at the hero's own size, and the line under it is one
/// sentence rather than a list.
export function Features({ className }: { className?: string }) {
  const shown = FEATURES.filter((f) => !f.hidden);
  const cards = shown.filter((f) => f.card);

  return (
    <section className={className}>
      {shown
        .filter((f) => !f.card)
        .map((f) => {
          const Illustration = ILLUSTRATIONS[f.id];
          return (
            <article key={f.id} id={f.id} className="mb-16 sm:mb-24">
              <div className={COLUMN}>
                <p className="mb-3 font-mono text-sm text-muted-foreground">
                  {f.label}
                </p>
                <h2 className="max-w-2xl font-display text-3xl leading-[1.1] font-medium tracking-tight text-balance sm:text-4xl">
                  {f.title}
                </h2>
                <p className="mt-3 max-w-xl text-base text-muted-foreground text-pretty sm:text-lg">
                  {f.line}
                </p>
              </div>
              <div className="mt-6 sm:mt-8">
                {Illustration ? (
                  <Illustration />
                ) : f.video ? (
                  <div className="overflow-hidden rounded-xl border border-border bg-card">
                    <LazyVideo
                      src={f.video.src}
                      poster={f.video.poster}
                      alt={f.video.alt}
                      className="block w-full"
                    />
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}

      {cards.length > 0 && (
        <div className="mb-16 sm:mb-24">
          <FeatureCards features={cards} />
        </div>
      )}
    </section>
  );
}
