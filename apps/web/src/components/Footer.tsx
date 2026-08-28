import { COMPANY } from "@/lib/links";

/// One muted line: who makes it. No links — the nav and the pitch already
/// carry the repo and feedback, and a third copy at the bottom is chrome
/// with nowhere new to lead. The licence lives under the download button,
/// where it answers "what am I installing"; down here it was a second copy.
/// No rule above it either: the last feature's own bottom margin is the gap,
/// and a line there boxed the page.
export function Footer({ className }: { className?: string }) {
  return (
    <footer
      className={`py-6 text-xs text-muted-foreground sm:text-sm ${className ?? ""}`}
    >
      © {new Date().getFullYear()} {COMPANY}
    </footer>
  );
}
