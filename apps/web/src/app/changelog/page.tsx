import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Closing } from "@/components/home/Closing";
import { SiteNav } from "@/components/home/SiteNav";
import { loadChangelog, type Item } from "@/lib/changelog";

export const metadata: Metadata = {
  title: "Changelog - Dray",
  description: "What changed in each Dray release.",
};

const LABEL = "font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase";

/// Each kind's square. Yellow and red stay out: in the app they mean "wants
/// you" and "failed".
const CATEGORY = {
  new: { label: "New", square: "bg-[#3DD68C] light:bg-[#0B8A5A]" },
  improved: { label: "Improved", square: "bg-[#1612F8]" },
  fixed: { label: "Fixed", square: "bg-[#C98BFF] light:bg-[#8526D1]" },
} as const;

/// The three inline marks a changelog line uses — code, bold and a link — and
/// nothing else, so no markdown library rides into the bundle for them.
function inline(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g)
    .map((part, i) => {
      if (part.startsWith("`") && part.endsWith("`"))
        return (
          <code key={i} className="rounded-[4px] bg-white/10 px-1 font-mono text-[0.85em] text-[#CFCFCF] light:bg-black/[0.06] light:text-[#0A0A0A]">
            {part.slice(1, -1)}
          </code>
        );
      if (part.startsWith("**") && part.endsWith("**"))
        return (
          <strong key={i} className="font-medium text-white light:text-[#0A0A0A]">
            {part.slice(2, -2)}
          </strong>
        );
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      if (link)
        return (
          <a key={i} href={link[2]} className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white light:text-[#0A0A0A] light:decoration-black/30 light:hover:decoration-black">
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
        <span className="size-1 bg-[#5A5A5A] light:bg-[#B0B0B0]" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        {item.title && <p className="font-medium text-white light:text-[#0A0A0A]">{inline(item.title)}</p>}
        {item.body.split("\n\n").map((p, i) => (
          <p key={i} className="text-pretty text-[#A1A1A1] light:text-[#5C5C5C]">
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
              className="!mt-3 w-full rounded-[6px] border border-white/15 light:border-black/10"
            />
          ) : (
            // Remote and unsized, so next/image would want config for nothing.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={m.url}
              src={m.url}
              alt={m.alt}
              loading="lazy"
              className="!mt-3 w-full rounded-[6px] border border-white/15 light:border-black/10"
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
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <main className="px-5 pb-[120px] sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav />

          <div className="lg:ml-[102px] lg:max-w-[756px]">
            <h1 className="pt-16 font-inter text-[36px] leading-[40px] font-normal tracking-[-0.03em] text-balance sm:pt-[101px] sm:text-[46px] sm:leading-[46px]">
              Changelog
            </h1>
            <p className="mt-4 text-[16px] leading-6 tracking-[-0.01em] text-[#7C7C7C] light:text-[#8A8A8A]">
              What changed in each Dray release.
            </p>

            <div className="mt-16 border-t border-white/20 light:border-black/15">
              {releases.map((r) => (
                <article
                  key={r.version}
                  className="grid gap-6 border-b border-white/20 py-12 sm:grid-cols-[140px_1fr] light:border-black/15"
                >
                  <header className="flex gap-3 sm:flex-col sm:gap-1.5">
                    <h2 className={`${LABEL} text-white light:text-[#0A0A0A]`}>{r.version}</h2>
                    {r.date && (
                      <time dateTime={r.date} className={`${LABEL} text-[#7C7C7C] light:text-[#8A8A8A]`}>
                        {formatDate(r.date)}
                      </time>
                    )}
                  </header>
                  <div className="space-y-10">
                    {r.sections.map((s) => (
                      <section key={s.kind}>
                        <h3 className={`${LABEL} mb-4 flex items-center gap-2 text-white light:text-[#0A0A0A]`}>
                          <span aria-hidden className={`size-2 ${CATEGORY[s.kind].square}`} />
                          {CATEGORY[s.kind].label}
                        </h3>
                        <ul className="space-y-5 text-[15px] leading-6 tracking-[-0.01em]">
                          {s.items.map((item, i) => (
                            <ChangelogItem key={i} item={item} />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </main>
      <Closing />
    </div>
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
