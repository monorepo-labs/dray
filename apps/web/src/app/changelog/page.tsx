import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { loadChangelog, type Item } from "@/lib/changelog";

export const metadata: Metadata = {
  title: "Changelog - Dray",
  description: "What changed in each Dray release.",
};

const COLUMN = "mx-auto w-full max-w-3xl px-3";

/// Heroicons' 16px solid set, the app's own icons for these, inlined so the
/// site takes no dependency for three paths.
const PATHS = {
  sparkles:
    "M5 4a.75.75 0 0 1 .738.616l.252 1.388A1.25 1.25 0 0 0 6.996 7.01l1.388.252a.75.75 0 0 1 0 1.476l-1.388.252A1.25 1.25 0 0 0 5.99 9.996l-.252 1.388a.75.75 0 0 1-1.476 0L4.01 9.996A1.25 1.25 0 0 0 3.004 8.99l-1.388-.252a.75.75 0 0 1 0-1.476l1.388-.252A1.25 1.25 0 0 0 4.01 6.004l.252-1.388A.75.75 0 0 1 5 4ZM12 1a.75.75 0 0 1 .721.544l.195.682c.118.415.443.74.858.858l.682.195a.75.75 0 0 1 0 1.442l-.682.195a1.25 1.25 0 0 0-.858.858l-.195.682a.75.75 0 0 1-1.442 0l-.195-.682a1.25 1.25 0 0 0-.858-.858l-.682-.195a.75.75 0 0 1 0-1.442l.682-.195a1.25 1.25 0 0 0 .858-.858l.195-.682A.75.75 0 0 1 12 1ZM10 11a.75.75 0 0 1 .728.568.968.968 0 0 0 .704.704.75.75 0 0 1 0 1.456.968.968 0 0 0-.704.704.75.75 0 0 1-1.456 0 .968.968 0 0 0-.704-.704.75.75 0 0 1 0-1.456.968.968 0 0 0 .704-.704A.75.75 0 0 1 10 11Z",
  arrowUpCircle:
    "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm-.75 10.25a.75.75 0 0 0 1.5 0V6.56l1.22 1.22a.75.75 0 1 0 1.06-1.06l-2.5-2.5a.75.75 0 0 0-1.06 0l-2.5 2.5a.75.75 0 0 0 1.06 1.06l1.22-1.22v4.69Z",
  wrench:
    "M11.5 8a3.5 3.5 0 0 0 3.362-4.476c-.094-.325-.497-.39-.736-.15L12.099 5.4a.48.48 0 0 1-.653.033 8.554 8.554 0 0 1-.879-.879.48.48 0 0 1 .033-.653l2.027-2.028c.24-.239.175-.642-.15-.736a3.502 3.502 0 0 0-4.476 3.427c.018.99-.133 2.093-.914 2.7l-5.31 4.13a2.015 2.015 0 1 0 2.828 2.827l4.13-5.309c.607-.78 1.71-.932 2.7-.914L11.5 8ZM3 13.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z",
};

/// Each kind's mark and colour. Tokens, not literals, so both modes keep them
/// readable; yellow and red stay out, meaning "wants you" and "failed".
const CATEGORY = {
  new: { label: "New", path: PATHS.sparkles, color: "text-accent-add" },
  improved: { label: "Improved", path: PATHS.arrowUpCircle, color: "text-accent-mention" },
  fixed: { label: "Fixed", path: PATHS.wrench, color: "text-accent-issue" },
} as const;

/// The three inline marks a changelog line uses — code, bold and a link — and
/// nothing else, so no markdown library rides into the bundle for them.
function inline(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g)
    .map((part, i) => {
      if (part.startsWith("`") && part.endsWith("`"))
        return (
          <code key={i} className="rounded bg-muted px-1 font-mono text-[0.9em]">
            {part.slice(1, -1)}
          </code>
        );
      if (part.startsWith("**") && part.endsWith("**"))
        return (
          <strong key={i} className="font-medium text-foreground">
            {part.slice(2, -2)}
          </strong>
        );
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      if (link)
        return (
          <a key={i} href={link[2]} className="text-foreground underline underline-offset-4">
            {link[1]}
          </a>
        );
      return part;
    });
}

function ChangelogItem({ item }: { item: Item }) {
  return (
    <li className="flex gap-3">
      {/* Hung on the first line's own height, so wrapped text lines up with
          the text rather than with the marker. */}
      <span aria-hidden className="flex h-[1lh] shrink-0 items-center">
        <span className="size-[5px] rounded-full bg-muted-foreground/60" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        {item.title && <p className="font-medium text-foreground">{inline(item.title)}</p>}
        {item.body.split("\n\n").map((p, i) => (
          <p key={i} className="text-muted-foreground text-pretty">
            {inline(p)}
          </p>
        ))}
        {item.media.map((m) =>
          m.kind === "video" ? (
            <video
              key={m.url}
              src={m.url}
              aria-label={m.alt || undefined}
              controls
              playsInline
              preload="metadata"
              className="!mt-3 w-full rounded-lg border border-border"
            />
          ) : (
            // Remote and unsized, so next/image would want config for nothing.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={m.url}
              src={m.url}
              alt={m.alt}
              loading="lazy"
              className="!mt-3 w-full rounded-lg border border-border"
            />
          ),
        )}
      </div>
    </li>
  );
}

export default function Changelog() {
  // Betas are the app's beta channel's alone.
  const releases = loadChangelog().filter((r) => !r.beta && r.sections.length > 0);

  return (
    <main className={COLUMN}>
      <div className="pt-3 mb-10 sm:mb-14">
        <Nav />
      </div>

      <h1 className="font-display text-3xl leading-[1.1] font-medium tracking-tight sm:text-4xl">
        {"What's new in Dray"}
      </h1>

      <div className="mt-10 space-y-14 sm:mt-14">
        {releases.map((r) => (
          <article key={r.version} className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <header className="text-sm text-muted-foreground sm:pt-0.5">
              <h2 className="font-medium text-foreground">{r.version}</h2>
              {r.date && <time dateTime={r.date}>{formatDate(r.date)}</time>}
            </header>
            <div className="space-y-8">
              {r.sections.map((s) => {
                const { label, path, color } = CATEGORY[s.kind];
                return (
                  <section key={s.kind}>
                    <h3 className={`mb-3 flex items-center gap-1.5 text-sm font-medium ${color}`}>
                      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className="size-4">
                        <path fillRule="evenodd" clipRule="evenodd" d={path} />
                      </svg>
                      {label}
                    </h3>
                    <ul className="space-y-5 leading-relaxed">
                      {s.items.map((item, i) => (
                        <ChangelogItem key={i} item={item} />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </article>
        ))}
      </div>

      <Footer className="mt-20" />
    </main>
  );
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
