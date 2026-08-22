import { useMemo } from "react";
import { getFiletypeFromFileName, parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";

import { useCodeThemeWithMode } from "@/hooks/useCodeTheme";
import { useHighlighter } from "@/hooks/useHighlighter";
import { fileName, type EditSides } from "@/lib/diff";
import { cn } from "@/lib/utils";

/// `parseDiffFromFile` is pure and synchronous but walks both files, so it is
/// memoized on the text rather than run on every transcript re-render — a
/// streaming turn re-renders the whole list on each delta.
export default function DiffView({
  sides,
  className,
}: {
  sides: EditSides;
  className?: string;
}) {
  // Read here rather than threaded down from the transcript: nothing else
  // between here and the app root cares about either value, and props for them
  // would have to cross every row component to reach one leaf.
  const { pair, resolvedMode } = useCodeThemeWithMode();

  const name = fileName(sides.path);
  const ready = useHighlighter(getFiletypeFromFileName(name), pair);

  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        sides.oldText === null ? null : { name, contents: sides.oldText },
        { name, contents: sides.newText },
      ),
    [name, sides.oldText, sides.newText],
  );

  const options = useMemo(
    () => ({
      theme: pair,
      themeType: resolvedMode,
      // Unified: the transcript column is far too narrow for two gutters plus
      // two code columns, and a side-by-side view there wraps into noise.
      diffStyle: "unified" as const,
      // The row above already names the file, so a second header would repeat
      // it directly under itself.
      disableFileHeader: true,
      // Long lines wrap instead of scrolling. A horizontal scrollbar inside a
      // vertically scrolling transcript traps the wheel and is easy to miss.
      overflow: "wrap" as const,
    }),
    [pair, resolvedMode],
  );

  const frame = cn("overflow-hidden rounded-md border border-border/60 text-code", className);

  // An unhighlighted stand-in rather than an empty box: a grammar fetch runs
  // from ~10ms to several hundred, and a blank frame that long reads as a
  // stall. Tinting by sign keeps the one thing a diff is for — which side a
  // line is on — legible before any syntax color arrives.
  if (!ready) {
    return (
      <pre className={cn(frame, "max-h-96 overflow-auto px-2.5 py-2 font-mono")}>
        {sides.oldText !== null &&
          sides.oldText.split("\n").map((line, i) => (
            <div key={`-${i}`} className="text-destructive">
              -{line}
            </div>
          ))}
        {sides.newText.split("\n").map((line, i) => (
          <div key={`+${i}`} className="text-emerald-400">
            +{line}
          </div>
        ))}
      </pre>
    );
  }

  return <FileDiff fileDiff={fileDiff} options={options} className={frame} />;
}
