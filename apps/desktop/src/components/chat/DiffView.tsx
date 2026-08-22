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
  diffStyle = "unified",
  overflow = "wrap",
  fill = false,
  unsafeCSS,
}: {
  sides: EditSides;
  className?: string;
  /// Side by side, or one column. Only the repo view's own pane asks for
  /// `split`, and it must pass `overflow: "scroll"` with it — the library only
  /// wires the two columns' scrolling together when lines can overflow, so a
  /// wrapping split view scrolls its halves independently.
  ///
  /// A prop rather than a second component: the highlighter gate below is the
  /// part that is easy to get wrong, and it should exist once. Changing it
  /// repaints the same instance and never re-tokenizes — the layout is the
  /// client's, while the worker pool's cache is keyed on the text.
  diffStyle?: "unified" | "split";
  overflow?: "wrap" | "scroll";
  /// Grow to the height of the container instead of capping. For a pane whose
  /// whole job is this diff, where the cap the transcript needs would leave
  /// most of the window empty.
  fill?: boolean;
  /// Rules injected into the viewer's shadow root, in the library's own
  /// `unsafe` layer. Its escape hatch for the handful of things it styles but
  /// exposes no variable for — see `DIFF_CSS` in `DiffPane`.
  unsafeCSS?: string;
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
      // Unified by default: the transcript column is far too narrow for two
      // gutters plus two code columns, and a side-by-side view there wraps into
      // noise. A dedicated pane has the width and asks for `split`.
      diffStyle,
      // The row above already names the file, so a second header would repeat
      // it directly under itself.
      disableFileHeader: true,
      // Wrapping by default: a horizontal scrollbar inside a vertically
      // scrolling transcript traps the wheel and is easy to miss.
      overflow,
      unsafeCSS,
    }),
    [pair, resolvedMode, diffStyle, overflow, unsafeCSS],
  );

  const frame = cn(
    "overflow-hidden rounded-md border border-border/60 text-code",
    fill && "h-full",
    className,
  );

  // An unhighlighted stand-in rather than an empty box: a grammar fetch runs
  // from ~10ms to several hundred, and a blank frame that long reads as a
  // stall. Tinting by sign keeps the one thing a diff is for — which side a
  // line is on — legible before any syntax color arrives.
  if (!ready) {
    return (
      <pre
        className={cn(
          frame,
          "overflow-auto px-2.5 py-2 font-mono",
          fill ? "h-full" : "max-h-96",
        )}
      >
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
