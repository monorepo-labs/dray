import { GitHubGlyph } from "@/components/GitHubGlyph";
import { Wordmark } from "@/components/Wordmark";
import { FEEDBACK, REPO } from "@/lib/links";

/// Wordmark left, two links right.
export function Nav() {
  return (
    <nav className="flex items-center justify-between">
      <Wordmark className="h-3.5 w-auto" />
      <div className="flex items-center gap-4 text-xs text-muted-foreground sm:text-sm">
        <a
          href={FEEDBACK}
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-foreground"
        >
          Feedback
        </a>
        {/* Links, not pills: the download button below is the page's one
            action, and a bordered control up here competed with it. */}
        <a
          href={REPO}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
        >
          <GitHubGlyph className="size-4" />
          <span>GitHub</span>
        </a>
      </div>
    </nav>
  );
}
