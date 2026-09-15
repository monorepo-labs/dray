import { useCallback, useMemo, useRef } from "react";
import { getFiletypeFromFileName } from "@pierre/diffs";
import { File } from "@pierre/diffs/react";

import { useCodeThemeWithMode } from "@/hooks/useCodeTheme";
import { useHighlighter } from "@/hooks/useHighlighter";
import type { OpenFile } from "@/hooks/useOpenFiles";
import { fileName } from "@/lib/diff";
import { cn } from "@/lib/utils";

/// The line a chat link named, painted where the row sits.
///
/// `unsafeCSS` lands in the library's own `unsafe` layer, last in its layer
/// order, so this wins with no `!important` — the same escape hatch `DiffPane`
/// takes for the split view's gutter. The colour is the app's own accent rather
/// than a `--diffs-*` token, since the library has none for "the line somebody
/// was sent to".
const TARGET_CSS = `[data-target] { background: color-mix(in oklab, var(--primary) 18%, transparent); }`;

/// The active file, read and highlighted.
///
/// Read-only throughout: the one control here that writes anything is the
/// button handing the path to the reader's own editor, and that writes nothing
/// either.
export default function FileViewer({
  file,
}: {
  /// Null where nothing is open, which is the view's own empty state.
  file: OpenFile | null;
}) {
  const { pair, resolvedMode } = useCodeThemeWithMode();
  const path = file?.path ?? "";
  const name = fileName(path);
  const ready = useHighlighter(getFiletypeFromFileName(name), pair);

  // Which reveal this pane has already scrolled for. Held in a ref rather than
  // state, since scrolling is not something to re-render over — and keyed on
  // the counter rather than the line, or clicking the same link twice would
  // leave the reader wherever they had scrolled to.
  const scrolled = useRef<string | null>(null);
  const line = file?.line;
  const revealKey = file ? `${file.path}\n${file.reveal}` : null;

  // `onPostRender` hands back the *host* element, whose rows live in its shadow
  // root, so the query has to cross that boundary explicitly — the same reading
  // `CodeView`'s gutter rewrite takes.
  const mark = useCallback(
    (host: HTMLElement) => {
      const root: ParentNode = host.shadowRoot ?? host;
      for (const stale of root.querySelectorAll("[data-target]")) {
        stale.removeAttribute("data-target");
      }
      if (!line || !revealKey) return;

      // Zero-based on the wire, one-based to the reader. A line past the end of
      // the file matches nothing and marks nothing, which is the right answer
      // for a reference that has gone stale.
      const rows = root.querySelectorAll(`[data-line-index="${line - 1}"]`);
      for (const row of rows) row.setAttribute("data-target", "");

      if (scrolled.current === revealKey) return;
      scrolled.current = revealKey;
      rows[0]?.scrollIntoView({ block: "center" });
    },
    [line, revealKey],
  );

  const options = useMemo(
    () => ({
      theme: pair,
      themeType: resolvedMode,
      // The header row above already names the file.
      disableFileHeader: true,
      // Scroll rather than wrap: this is a pane with the window's whole width,
      // where a wrapped long line costs the gutter's meaning.
      overflow: "scroll" as const,
      unsafeCSS: TARGET_CSS,
      onPostRender: mark,
    }),
    [pair, resolvedMode, mark],
  );

  const text = file?.state.status === "ready" && file.state.body.kind === "text"
    ? file.state.body.text
    : null;

  const contents = useMemo(() => (text === null ? null : { name, contents: text }), [name, text]);

  if (!file) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-ui text-muted-foreground">
        Pick a file to read it.
      </div>
    );
  }

  // No header row: the tab strip above already names the file and carries the
  // full path on its own `title`, so a second line here would say it twice —
  // the reading the Docs panel's chip strip takes. No padding either: the
  // pane's own border is the frame, and an inset would only make the code
  // narrower than the window it was given.
  return (
    <div className="min-h-0 flex-1 overflow-auto text-code">
      <Body file={file} contents={contents} options={options} ready={ready} />
    </div>
  );
}

function Body({
  file,
  contents,
  options,
  ready,
}: {
  file: OpenFile;
  contents: { name: string; contents: string } | null;
  options: Parameters<typeof File>[0]["options"];
  ready: boolean;
}) {
  const note = (text: string, tone?: "error") => (
    <p
      className={cn(
        "px-3 py-2 text-ui",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {text}
    </p>
  );

  if (file.state.status === "loading") return note("Loading…");
  if (file.state.status === "error") return note(file.state.message, "error");

  if (file.state.body.kind === "image") {
    return (
      // A checkerboard behind it, since a transparent PNG on a dark page is an
      // image of nothing. Natural size capped to the pane rather than stretched
      // to it — a 16px icon blown up to the window is a lie about the file.
      <div
        className="flex min-h-full items-center justify-center p-6"
        style={{
          backgroundImage:
            "repeating-conic-gradient(var(--muted) 0% 25%, transparent 0% 50%)",
          backgroundSize: "16px 16px",
        }}
      >
        <img
          src={file.state.body.dataUrl}
          alt={file.path}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  // Plain text while the grammar loads, not an empty box: a grammar fetch runs
  // from ~10ms to several hundred, and a blank pane that long reads as a stall.
  if (!ready || !contents) {
    return <pre className="px-2.5 py-2 font-mono whitespace-pre">{contents?.contents ?? ""}</pre>;
  }

  return <File file={contents} options={options} />;
}
