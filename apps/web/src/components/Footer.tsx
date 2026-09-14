import { XGlyph } from "@/components/XGlyph";
import { COMPANY, FEEDBACK } from "@/lib/links";

/// Who makes it, and where to find the person who does. One link only: the
/// nav carries the repo, and the licence sits under the download button where
/// it answers "what am I installing".
///
/// It pointed at the product's own account and points at the maker's instead —
/// the same one the nav's "Feedback" link opens. A second copy of one address
/// beats a lone link to an account that posts releases, since somebody who
/// reaches the bottom of this page is looking for a person.
///
/// Mark alone, no handle beside it — the mark is the name here, and spelling
/// it out put the loudest thing on the page's quietest line. The label moves
/// to `aria-label`, since a glyph on its own says nothing to a screen reader.
/// No rule above it either: the last section's own bottom margin is the gap,
/// and a line there boxed the page.
export function Footer({ className }: { className?: string }) {
  return (
    <footer
      className={`flex items-center justify-between py-6 text-xs text-muted-foreground sm:text-sm ${className ?? ""}`}
    >
      <span>
        © {new Date().getFullYear()} {COMPANY}
      </span>
      <a
        href={FEEDBACK}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Yogesh on X"
        className="transition-colors hover:text-foreground"
      >
        <XGlyph className="size-3" />
      </a>
    </footer>
  );
}
