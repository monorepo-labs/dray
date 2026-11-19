import { useId, useState } from "react";

import SettingRow from "@/components/settings/SettingRow";
import { Button } from "@/components/ui/button";
import { setMarkdownRenderer, useMarkdownRenderer, type MarkdownRenderer } from "@/lib/markdownRenderer";
import type { BenchResult } from "@/bench/markdownBench";

const RENDERERS: { id: MarkdownRenderer; label: string }[] = [
  { id: "streamdown", label: "Streamdown" },
  { id: "words", label: "Words" },
];

const ROWS: { key: string; label: string; digits: number }[] = [
  { key: "fullSync", label: "Full render, sync (ms)", digits: 1 },
  { key: "fullFirstFrame", label: "Full render, first frame (ms)", digits: 1 },
  { key: "fullSettled", label: "Full render, settled (ms)", digits: 0 },
  { key: "domNodes", label: "DOM nodes", digits: 0 },
  { key: "rssDeltaMB", label: "RSS added (MB)", digits: 1 },
  { key: "chunkMedian", label: "Per chunk, median (ms)", digits: 2 },
  { key: "chunkP95", label: "Per chunk, p95 (ms)", digits: 2 },
  { key: "chunkMax", label: "Per chunk, max (ms)", digits: 1 },
  { key: "droppedFrames", label: "Dropped frames", digits: 0 },
  { key: "longFrames", label: "Frames over 50ms", digits: 0 },
  { key: "streamWall", label: "Stream wall time (ms)", digits: 0 },
  { key: "finalCommit", label: "Final commit (ms)", digits: 1 },
];

/// Settings → Developer, in a dev build only: which library draws chat
/// markdown, and the benchmark between them.
export default function MarkdownDevRows() {
  const id = useId();
  const renderer = useMarkdownRenderer();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BenchResult | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const { runMarkdownBench } = await import("@/bench/markdownBench");
      setResult(await runMarkdownBench());
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <SettingRow id={id} asGroup label="Markdown renderer" description="Dev builds only. Chat, plans, PRs and issues.">
        <div className="flex gap-1" role="radiogroup" aria-labelledby={id}>
          {RENDERERS.map((r) => (
            <Button
              key={r.id}
              size="sm"
              variant={renderer === r.id ? "default" : "ghost"}
              role="radio"
              aria-checked={renderer === r.id}
              onClick={() => setMarkdownRenderer(r.id)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </SettingRow>
      <SettingRow
        id={`${id}-bench`}
        label="Markdown benchmark"
        description="Streamdown against Words on real replies, seven runs each. Takes a few minutes."
      >
        <Button size="sm" variant="secondary" disabled={running} onClick={() => void run()}>
          {running ? "Running…" : "Run"}
        </Button>
      </SettingRow>
      <SettingRow
        id={`${id}-compare`}
        label="Side by side"
        description="The same real replies in both renderers. Escape closes it."
      >
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void import("@/bench/markdownCompare").then((m) => m.showMarkdownCompare())}
        >
          Show
        </Button>
      </SettingRow>
      {result && (
        <table className="w-full font-mono text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 text-left font-normal">Median of {result.runs}</th>
              {Object.keys(result.medians).map((v) => (
                <th key={v} className="py-1 text-right font-normal">
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.key} className="border-t border-border/40">
                <td className="py-1">{row.label}</td>
                {Object.entries(result.medians).map(([v, m]) => (
                  <td key={v} className="py-1 text-right tabular-nums">
                    {m[row.key] === null ? "—" : m[row.key]!.toFixed(row.digits)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
