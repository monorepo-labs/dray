import { GitHubGlyph } from "@/components/GitHubGlyph";
import { REPO } from "@/lib/links";

/// The repo, as the quiet twin of the download button — hero and CTA both
/// draw the pair, so the pill is stated once.
export function ContributeButton({ className }: { className?: string }) {
  return (
    <a
      href={REPO}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? "inline-flex items-center gap-2 rounded-full bg-card px-5 py-2.5 text-sm font-medium transition-colors hover:bg-muted"}
    >
      <GitHubGlyph className="size-4" />
      Contribute on GitHub
    </a>
  );
}
