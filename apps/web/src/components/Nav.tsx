import { GitHubGlyph, StarGlyph } from "@/components/GitHubGlyph";
import { Wordmark } from "@/components/Wordmark";
import { fetchStars, formatStars } from "@/lib/github";
import { FEEDBACK, REPO } from "@/lib/links";

/// Wordmark left, two links right. A server component so the star count
/// arrives in the HTML and never pops in after paint.
export async function Nav() {
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
        <a href="/changelog" className="transition-colors hover:text-foreground">
          {"What's new"}
        </a>
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
      </div>
    </nav>
  );
}
