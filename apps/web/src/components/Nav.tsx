import type { ReactNode } from "react";

import { GitHubGlyph, StarGlyph } from "@/components/GitHubGlyph";
import { Wordmark } from "@/components/Wordmark";
import { fetchStars, formatStars } from "@/lib/github";
import { FEEDBACK, REPO, SPONSOR } from "@/lib/links";

/// Wordmark left, two links right. A server component so the star count
/// arrives in the HTML and never pops in after paint. `action` goes last on
/// the right, for a page that wants its button up here too. `sponsor` swaps
/// "What's new" for a Sponsor link after Feedback, the product preview's set.
export async function Nav({ action, sponsor = false }: { action?: ReactNode; sponsor?: boolean } = {}) {
  const stars = await fetchStars();

  return (
    <nav className="flex items-center justify-between">
      <a href="/" aria-label="Dray home">
        <Wordmark className="h-3.5 w-auto" />
      </a>
      <div className="flex items-center gap-4 text-xs whitespace-nowrap text-muted-foreground sm:text-sm">
        <a href="/docs" className="transition-colors hover:text-foreground">
          Docs
        </a>
        {!sponsor && (
          <a href="/changelog" className="transition-colors hover:text-foreground">
            {"What's new"}
          </a>
        )}
        <a
          href={FEEDBACK}
          target="_blank"
          rel="noopener noreferrer"
          // Off on a phone, where four links wrap: the footer's X mark goes
          // to the same place.
          className="hidden transition-colors hover:text-foreground sm:inline"
        >
          Feedback
        </a>
        {sponsor && (
          <a href={SPONSOR} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-foreground">
            Sponsor
          </a>
        )}
        {/* Links, not pills: the download button below is the page's one
            action, and a bordered control up here competed with it. The star
            and count still ride along — they say the repo is alive, which
            the word "GitHub" alone does not. */}
        <a
          href={REPO}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
        >
          <GitHubGlyph className="size-4" />
          <span>GitHub</span>
          <StarGlyph className="ml-0.5 size-3" />
          <span className="tabular-nums">{formatStars(stars)}</span>
        </a>
        {action}
      </div>
    </nav>
  );
}
