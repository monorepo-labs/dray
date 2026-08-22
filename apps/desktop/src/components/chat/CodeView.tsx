import { useMemo } from "react";
import { getFiletypeFromFileName } from "@pierre/diffs";
import { File } from "@pierre/diffs/react";

import { useCodeThemeWithMode } from "@/hooks/useCodeTheme";
import { useHighlighter } from "@/hooks/useHighlighter";
import { fileName, type ReadRange } from "@/lib/diff";
import { cn } from "@/lib/utils";

/// The slice a ranged `Read` returned, highlighted. Not a diff — nothing
/// changed — so this is the `File` renderer with the gutter offset to match the
/// real line numbers.
export default function CodeView({
  range,
  className,
}: {
  range: ReadRange;
  className?: string;
}) {
  const { pair, resolvedMode } = useCodeThemeWithMode();

  const name = fileName(range.path);
  const ready = useHighlighter(getFiletypeFromFileName(name), pair);

  const file = useMemo(
    () => ({ name, contents: range.text }),
    [name, range.text],
  );

  // The renderer numbers a file from 1 and exposes no starting-line option, so
  // the gutter is rewritten after each render. Padding the content with blank
  // lines would also work for a read near the top of a file and collapses for
  // one that isn't — an `offset` of 420 renders 419 empty rows.
  //
  // `onPostRender` hands back the host element, whose rows live in its shadow
  // root, so the query has to cross that boundary explicitly.
  const offset = range.startLine - 1;
  const renumber = useMemo(
    () => (host: HTMLElement) => {
      if (offset <= 0) return;
      const root: ParentNode = host.shadowRoot ?? host;
      for (const cell of root.querySelectorAll("[data-line-number-content]")) {
        const index = Number(cell.parentElement?.getAttribute("data-line-index"));
        if (Number.isFinite(index)) cell.textContent = String(index + 1 + offset);
      }
    },
    [offset],
  );

  const options = useMemo(
    () => ({
      theme: pair,
      themeType: resolvedMode,
      // The row above already names the file.
      disableFileHeader: true,
      overflow: "wrap" as const,
      onPostRender: renumber,
    }),
    [pair, resolvedMode, renumber],
  );

  const frame = cn("overflow-hidden rounded-md border border-border/60 text-code", className);

  // Plain text while the grammar loads, not an empty box. Grammar fetches range
  // from ~10ms to several hundred (Ruby pulls HTML, CSS, JS and SQL along for
  // its embedded syntaxes), and a blank frame for that long reads as a stall.
  // Showing the code immediately means the only thing that arrives late is
  // color, which is also why the padding and leading here have to match the
  // rendered view — otherwise the text jumps when it lands.
  if (!ready) {
    return (
      <pre
        className={cn(frame, "max-h-96 overflow-auto px-2.5 py-2 font-mono whitespace-pre-wrap")}
      >
        {range.text}
      </pre>
    );
  }

  // Capped rather than unbounded: a `limit` of 2000 is legal and would other-
  // wise push the rest of the transcript off-screen.
  return (
    <div className={cn(frame, "max-h-96 overflow-auto")}>
      <File file={file} options={options} />
    </div>
  );
}
