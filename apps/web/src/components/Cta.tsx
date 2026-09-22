import { Heart } from "lucide-react";

import { ContributeButton } from "@/components/ContributeButton";
import { DownloadButton } from "@/components/DownloadButton";
import { XGlyph } from "@/components/XGlyph";
import { FEEDBACK } from "@/lib/links";

/// The last word: one sentence, the download again, and the repo. The
/// hero's button is a screen and a half up by now, and somebody who read this
/// far has decided — so the ask is here, where they are.
export function Cta({ className }: { className?: string }) {
  return (
    <section
      id="download"
      className={`flex flex-col items-center py-16 text-center sm:py-24 ${className ?? ""}`}
    >
      {/* The sentence is about the people it is built with, and a heart is
          the one glyph that says so without a word. Filled, since an
          outline at this size reads as a button with nothing behind it. */}
      <Heart className="mb-6 size-12 fill-current text-[oklch(0.62_0.24_25)]" strokeWidth={1.5} aria-hidden />
      <p className="max-w-3xl font-display text-2xl leading-[1.2] font-medium tracking-tight text-balance sm:text-4xl">
        Dray is free and open source, built in the open with the people who run
        agents all day. Issues, pull requests and ideas are all welcome.
      </p>
      <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
        <DownloadButton />
        <ContributeButton />
        {/* The person, not the product account — same reasoning as the nav's
            Feedback link: most visitors came from a tweet and are looking for
            who made it. */}
        <a
          href={FEEDBACK}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-full bg-card px-5 py-2.5 text-sm font-medium transition-colors hover:bg-muted"
        >
          <XGlyph className="size-3.5" />
          Follow the journey
        </a>
      </div>
    </section>
  );
}
