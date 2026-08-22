import { useEffect } from "react";
import { areThemesEqual } from "@pierre/diffs";
import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
// Vite's `?worker` turns the package's worker entry into a constructor and
// owns bundling it — the library takes a factory precisely because it can't
// know the host's bundler.
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";

import { COMMON_LANGS } from "@/hooks/useHighlighter";
import type { CodeThemePair } from "@/lib/codeTheme";

/// Moves diff highlighting off the main thread.
///
/// Without a pool every `FileDiff`/`File` tokenizes on the main thread, and the
/// cost scales with the *whole file*, not the change — the library highlights
/// both full sides, so expanding a several-hundred-line TS file froze the app
/// for 200ms–1s. With a pool in context the renderer paints an unhighlighted
/// diff immediately and patches colors in when the worker answers, and a pool
/// failure falls back to the main-thread path on its own (`isWorkingPool`).
///
/// Two workers, not the library's default eight: each one boots its own Shiki
/// with its own grammars, and this app opens one diff at a time — the second
/// worker only covers a burst of rows opened together.
export default function DiffWorkerPool({
  pair,
  children,
}: {
  pair: CodeThemePair;
  children: React.ReactNode;
}) {
  return (
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory: () => new DiffWorker(), poolSize: 2 }}
      highlighterOptions={{ langs: COMMON_LANGS, theme: pair }}
    >
      <PoolThemeSync pair={pair} />
      {children}
    </WorkerPoolContextProvider>
  );
}

/// The pool's theme *overrides* per-view theme options (`getLocalHighlightTheme`
/// prefers the manager's), and the singleton only reads `highlighterOptions` on
/// first creation — so a theme change after mount has to be pushed to the pool
/// or every diff keeps rendering in the old pair forever.
function PoolThemeSync({ pair }: { pair: CodeThemePair }) {
  const pool = useWorkerPool();

  useEffect(() => {
    if (!pool || areThemesEqual(pool.getDiffRenderOptions().theme, pair)) return;
    void pool.setRenderOptions({ theme: pair });
  }, [pool, pair]);

  return null;
}
