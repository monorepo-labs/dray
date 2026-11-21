import { useEffect, useMemo, useState } from "react";

import { Markdown } from "@/components/chat/Markdown";
import { FIRST_SECTIONS, SECTION_STEP, splitMarkdownSections } from "@/lib/markdown";
import { cn } from "@/lib/utils";

/// A markdown document, mounted a few sections at a time.
///
/// One commit was what made a long file take seconds to open: 282KB of markdown
/// measured at 930ms of parsing before any of the 608KB of HTML it produces
/// reached the DOM, and the commit and layout of that tree after it. A reader
/// opens a document at its top, so the top is what has to be on screen — the
/// rest arrives behind it, which is the bargain the transcript's own backfill
/// makes for a long session.
///
/// The total work is unchanged. What changes is that the main thread comes back
/// between steps, so the pane is readable and scrollable throughout instead of
/// frozen until the last section lands.
export default function MarkdownDoc({
  text,
  linkFilePaths,
  className,
}: {
  text: string;
  linkFilePaths?: "written";
  className?: string;
}) {
  const sections = useMemo(() => splitMarkdownSections(text), [text]);
  const [mounted, setMounted] = useState(FIRST_SECTIONS);

  useEffect(() => {
    if (mounted >= sections.length) return;
    // A macrotask rather than a frame: this is parse work, and yielding to the
    // event loop is what keeps a click or a keystroke from queueing behind it.
    const id = setTimeout(() => setMounted((n) => n + SECTION_STEP), 0);
    return () => clearTimeout(id);
  }, [mounted, sections.length]);

  return (
    <div className={cn("px-3 py-2", className)}>
      {sections.slice(0, mounted).map((section, i) => (
        // `Markdown` strips its own first child's top margin, which is right for
        // one message in a transcript and wrong for a section stacked under
        // another — without this every heading after the first would sit flush
        // against the paragraph above it.
        <div key={i} className={i > 0 ? "mt-4" : undefined}>
          <Markdown linkFilePaths={linkFilePaths}>{section}</Markdown>
        </div>
      ))}
    </div>
  );
}
