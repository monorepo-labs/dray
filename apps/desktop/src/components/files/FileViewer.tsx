import { useCallback, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getFiletypeFromFileName } from "@pierre/diffs";
import { File, Virtualizer } from "@pierre/diffs/react";

import Note from "@/components/changes/Note";
import { useCodeThemeWithMode } from "@/hooks/useCodeTheme";
import { useHighlighter } from "@/hooks/useHighlighter";
import type { OpenFile } from "@/hooks/useOpenFiles";
import { diffSide } from "@/lib/diff";
import { basename } from "@/lib/format";

/// The line a chat link named, painted where the row sits.
///
/// `unsafeCSS` lands in the library's own `unsafe` layer, last in its layer
/// order, so this wins with no `!important` — the same escape hatch `DiffPane`
/// takes for the split view's gutter. The colour is the app's own accent rather
/// than a `--diffs-*` token, since the library has none for "the line somebody
/// was sent to".
const TARGET_CSS = `[data-target] { background: color-mix(in oklab, var(--primary) 18%, transparent); }`;

/// What `onPostRender` hands back once `File` runs under a `Virtualizer`: a
/// `VirtualizedFile`, which can say where a line sits without drawing it. Both
/// optional, since the callback is typed against the plain `File`.
type VirtualizedInstance = {
  getLinePosition?: (line: number) => { top: number; height: number } | undefined;
  getEditorViewport?: () => HTMLElement | Document | undefined;
};

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
  const name = basename(path);
  const ready = useHighlighter(getFiletypeFromFileName(name), pair);

  // Which reveal this pane has already scrolled for. Held in a ref rather than
  // state, since scrolling is not something to re-render over — and keyed on
  // the counter rather than the line, or clicking the same link twice would
  // leave the reader wherever they had scrolled to.
  const scrolled = useRef<string | null>(null);
  const line = file?.line;
  const revealKey = file ? `${file.path}\n${file.reveal}` : null;
  // What is on screen now, for a wait started under an earlier reveal. The
  // pane is reused across tab switches, so a frame armed for one file would
  // otherwise scroll the next one to the first file's line.
  const current = useRef(revealKey);
  current.current = revealKey;

  const text = file?.state.status === "ready" && file.state.body.kind === "text"
    ? file.state.body.text
    : null;
  const lineCount = useMemo(() => (text === null ? 0 : text.split("\n").length), [text]);

  // `onPostRender` hands back the *host* element, whose rows live in its shadow
  // root, so the query has to cross that boundary explicitly — the same reading
  // `CodeView`'s gutter rewrite takes. Under the virtualizer it fires on every
  // window the viewer draws, which is what re-marks the row as it scrolls in.
  const mark = useCallback(
    (host: HTMLElement, instance: unknown) => {
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

      if (scrolled.current === revealKey || line > lineCount) return;
      if (rows[0]) {
        scrolled.current = revealKey;
        rows[0].scrollIntoView({ block: "center" });
        return;
      }

      // Virtualized, so a row outside the first window is not in the DOM to
      // scroll to. The instance knows where it would sit; scrolling the pane
      // there draws the window that holds it, and the next post-render marks it.
      // Not this frame: this runs inside the virtualizer's own render pass,
      // before it has given the pane its virtual height, and a scroll issued
      // against a pane still 818px tall is clamped to nothing — measured. So
      // wait for the pane to be tall enough to hold the line, a frame or two,
      // and give up quietly if it never is.
      const virtualized = instance as VirtualizedInstance;
      const at = virtualized.getLinePosition?.(line);
      const pane = virtualized.getEditorViewport?.();
      if (!at || !(pane instanceof HTMLElement)) return;
      scrolled.current = revealKey;
      let frames = 0;
      const scrollWhenSized = () => {
        if (current.current !== revealKey) {
          // Cancelled, not done: switching back must scroll after all.
          if (scrolled.current === revealKey) scrolled.current = null;
          return;
        }
        if (pane.scrollHeight < at.top + at.height) {
          if (++frames < 60) requestAnimationFrame(scrollWhenSized);
          return;
        }
        pane.scrollTo({ top: at.top - (pane.clientHeight - at.height) / 2 });
      };
      requestAnimationFrame(scrollWhenSized);
    },
    [line, revealKey, lineCount],
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

  // Keyed on content like a diff side, so the pool caches the result and a
  // tab the reader comes back to does not tokenize again.
  const contents = useMemo(() => (text === null ? null : diffSide(path, text)), [path, text]);

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
  //
  // The `Virtualizer` is the scroll container, and its presence is what turns
  // `File` into a `VirtualizedFile` (`useFileInstance` reads the context): only
  // the rows in and around the viewport exist in the DOM. Without it an
  // 8000-line lockfile is 8000 rows laid out for a pane showing forty, on open
  // and again on every tab switch. `overflow: "scroll"` above is the library's
  // uniform-row path, so nothing is measured per line and the default 20px
  // metric is exactly the `--diffs-line-height` its rows are drawn at.
  return (
    <Virtualizer className="min-h-0 flex-1 overflow-auto text-code">
      <Body file={file} contents={contents} options={options} ready={ready} />
    </Virtualizer>
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
  if (file.state.status === "loading") return <Note text="Loading…" />;
  if (file.state.status === "error") return <Note text={file.state.message} error />;

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

  if (file.state.body.kind === "video") {
    // Keyed on the path so a failure on one tab does not stick to the next.
    return <Video key={file.path} path={file.state.body.path} />;
  }

  // Plain text while the grammar loads, not an empty box: a grammar fetch runs
  // from ~10ms to several hundred, and a blank pane that long reads as a stall.
  if (!ready || !contents) {
    return <pre className="px-2.5 py-2 font-mono whitespace-pre">{contents?.contents ?? ""}</pre>;
  }

  // Never zero-height. The virtualizer anchors scroll on each file's edge and
  // reads a host whose bottom sits at or above the viewport top as scrolled
  // past — which a host not yet rendered, at 0px, is. It then keeps that bottom
  // edge in place as the host grows to its virtual height, so an 8000-line file
  // opened at the top landed at the end. Measured; one pixel is the whole cure.
  return <File file={contents} options={options} style={{ minHeight: 1 }} />;
}

/// A video, streamed through the asset protocol `read_file` just allowed it on.
///
/// The container is judged by extension before this mounts, so the one thing
/// left to fail is the codec inside it — which is the reason the note gives.
function Video({ path }: { path: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Note text="This video's format can't be played here." error />;
  return (
    <div className="flex min-h-full items-center justify-center bg-black">
      <video
        src={convertFileSrc(path)}
        controls
        className="max-h-full max-w-full"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
