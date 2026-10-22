import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";

import DiffWorkerPool from "@/components/DiffWorkerPool";
import CodeView from "@/components/chat/CodeView";
import DiffView from "@/components/chat/DiffView";
import { Markdown } from "@/components/chat/Markdown";
import FileViewer from "@/components/files/FileViewer";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { useCodeTheme } from "@/hooks/useCodeTheme";
import type { OpenFile } from "@/hooks/useOpenFiles";
import { warmHighlighter } from "@/hooks/useHighlighter";
import big from "@/App.tsx?raw";
import "streamdown/styles.css";
import "../App.css";

/// Every surface that draws code, mounted through the real components with the
/// app's own highlighter wiring, each timed from mount to its first coloured
/// token. The question is whether code comes out highlighted — not blank, not
/// grey — and how fast, across every palette and both modes. Open it in Safari
/// or the app, never the session browser: JavaScriptCore is what the app runs
/// and V8 hides the engine gap (see "Rendering code" in CLAUDE.md).

const PATH = "/Users/me/dray/apps/desktop/src/App.tsx";
const lines = big.split("\n");
const edited = lines.map((l, i) => (i === 120 ? `${l} // edited` : i === 900 ? "" : l)).join("\n");
const fragment = lines.slice(100, 130).join("\n");
const fragmentNew = fragment.replace(/\n/, "\n// added by the edit\n");

const FENCES = [
  "A markdown answer with fences in four languages.",
  "```ts\nexport function add(a: number, b: number): number {\n  return a + b; // sum\n}\n```",
  '```rust\nfn main() {\n    let name = "dray";\n    println!("hello {name}");\n}\n```',
  "```python\ndef greet(name: str) -> str:\n    return f\"hi {name}\"\n```",
  "```bash\npnpm tauri dev --features cef\n```",
].join("\n\n");

const OPEN: OpenFile = {
  path: PATH,
  line: 1200,
  reveal: 1,
  state: { status: "ready", body: { kind: "text", text: big } },
} as OpenFile;

/// Whether `node` holds a token the highlighter coloured, looking through every
/// shadow root on the way, since the library draws inside one.
function coloured(node: ParentNode): boolean {
  if (node.querySelector("pre span[style*='color'], pre span[style*='--shiki']")) return true;
  for (const host of node.querySelectorAll("diffs-container")) {
    const root = host.shadowRoot;
    if (root && root.querySelector("[data-line] span[style]")) return true;
  }
  return false;
}

/// Every timing so far, per run, so the window title can carry them out to
/// whatever is reading it — a title is readable from outside the page.
const timings: Record<number, Record<string, number>> = {};
const SECTIONS = 5;

function report(run: number, label: string, ms: number, done: (run: number) => void) {
  (timings[run] ??= {})[label] = ms;
  document.title = Object.entries(timings)
    .map(([r, t]) => `${r === "0" ? "cold" : `warm${r}`}: ${Object.values(t).join("/")}`)
    .join(" | ");
  if (Object.keys(timings[run]).length === SECTIONS) done(run);
}

function Timed({
  label,
  run,
  done,
  children,
}: {
  label: string;
  run: number;
  done: (run: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [ms, setMs] = useState<number | null>(null);

  useEffect(() => {
    setMs(null);
    const start = performance.now();
    let frame = 0;
    const poll = () => {
      if (ref.current && coloured(ref.current)) {
        const took = Math.round(performance.now() - start);
        setMs(took);
        report(run, label, took, done);
        return;
      }
      if (performance.now() - start < 30000) frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(frame);
  }, [run]);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-ui font-medium">
        {label}{" "}
        <span className="text-muted-foreground">
          {ms === null ? "not coloured yet" : `coloured in ${ms}ms`}
        </span>
      </h2>
      <div ref={ref} key={run}>
        {children}
      </div>
    </section>
  );
}

function Page() {
  const { pair } = useCodeTheme();
  useEffect(() => warmHighlighter(pair), [pair]);
  const [run, setRun] = useState(0);
  // One warm pass on its own once the cold one lands, so a single load
  // answers both questions.
  const done = (finished: number) => {
    if (finished === 0) setTimeout(() => setRun((n) => (n === 0 ? 1 : n)), 1500);
  };
  const sides = useMemo(() => ({ path: PATH, oldText: big, newText: edited }), []);

  return (
    <DiffWorkerPool pair={pair}>
      <main className="mx-auto flex max-w-4xl flex-col gap-8 p-8 pb-64">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-medium">Code rendering</h1>
          <Button size="sm" onClick={() => setRun((n) => n + 1)}>
            Remount (warm)
          </Button>
          <span className="text-ui text-muted-foreground">
            {pair.light} / {pair.dark}
          </span>
        </div>
        <Timed label="Edit diff" run={run} done={done}>
          <DiffView sides={{ path: PATH, oldText: fragment, newText: fragmentNew }} />
        </Timed>
        <Timed label="Ranged Read" run={run} done={done}>
          <CodeView range={{ path: PATH, text: lines.slice(399, 600).join("\n"), startLine: 400 }} />
        </Timed>
        <Timed label="Markdown fences" run={run} done={done}>
          <Markdown>{FENCES}</Markdown>
        </Timed>
        <Timed label={`Full-file diff, ${lines.length} lines`} run={run} done={done}>
          <div className="h-96 overflow-auto rounded-md border border-border/60">
            <DiffView sides={sides} diffStyle="split" overflow="scroll" />
          </div>
        </Timed>
        <Timed label={`Files view, ${lines.length} lines, line 1200`} run={run} done={done}>
          <div className="flex h-96 flex-col rounded-md border border-border/60">
            <FileViewer file={OPEN} />
          </div>
        </Timed>
      </main>
      <DemoThemeBar />
    </DiffWorkerPool>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider>
      <Page />
    </TooltipProvider>
  </React.StrictMode>,
);
