import { XGlyph } from "@/components/XGlyph";
import { COMPANY, DRAY_X } from "@/lib/links";

/// Who makes it, and where it posts. One link only: the nav carries the repo
/// and the feedback DM, and the licence sits under the download button where
/// it answers "what am I installing". This account is the one destination
/// neither of those reaches. Mark alone, no handle beside it — the mark is
/// the name here, and spelling it out put the loudest thing on the page's
/// quietest line. The label moves to `aria-label`, since a glyph on its own
/// says nothing to a screen reader. No rule above it either: the last
/// feature's own bottom margin is the gap, and a line there boxed the page.
export function Footer({ className }: { className?: string }) {
  return (
    <footer
      className={`flex items-center justify-between py-6 text-xs text-muted-foreground sm:text-sm ${className ?? ""}`}
    >
      <span>
        © {new Date().getFullYear()} {COMPANY}
      </span>
      <a
        href={DRAY_X}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Dray on X"
        className="transition-colors hover:text-foreground"
      >
        <XGlyph className="size-3" />
      </a>
    </footer>
  );
}
