import { LazyVideo } from "@/components/LazyVideo";
import { FEATURES } from "@/lib/features";

/// Four sections, each a few lines of text with its capture underneath.
/// Stacked, not side by side: a capture of a desktop window only reads at
/// full column width, and beside a text column it was half that. Text
/// first, so the label names what the clip is about before it plays.
export function Features({ className }: { className?: string }) {
  return (
    <section className={className}>
      {FEATURES.map((f) => (
        <article key={f.id} id={f.id} className="mb-12 sm:mb-16">
          {/* The term first, small and muted: a reader who knows it can
              skip the sentence and the lines under it. */}
          <p className="mb-2 font-mono text-xs tracking-wide text-muted-foreground uppercase">
            {f.label}
          </p>
          <h2 className="font-mono text-base leading-tight font-medium tracking-tight sm:text-lg">
            {f.title}
          </h2>
          <ul className="mt-3 max-w-2xl space-y-1.5 text-sm text-muted-foreground sm:text-base">
            {f.points.map((p) => (
              <li key={p} className="flex gap-2.5">
                {/* Hand-drawn marker rather than `list-disc`: the bullet
                    takes a muted tone, so it marks a line without competing
                    with it. */}
                <span
                  aria-hidden
                  className="mt-[0.7em] size-1 shrink-0 rounded-full bg-muted-foreground/50"
                />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <div className="mt-5 overflow-hidden rounded-lg border border-border bg-card">
            <LazyVideo
              src={f.video.src}
              poster={f.video.poster}
              alt={f.video.alt}
              className="block w-full"
            />
          </div>
        </article>
      ))}
    </section>
  );
}
