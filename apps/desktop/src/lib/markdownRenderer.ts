import { useSyncExternalStore } from "react";

/// Which library draws chat markdown, in a dev build only (#1297): Streamdown,
/// what ships, or Pierre's Words, under evaluation. A production build never
/// reads this — `Markdown` folds the switch away on `import.meta.env.DEV`.
export type MarkdownRenderer = "streamdown" | "words";

const KEY = "dray.dev.markdownRenderer";

// Vitest runs dev-mode modules in node, where there is no `localStorage`.
let current: MarkdownRenderer =
  import.meta.env.DEV && globalThis.localStorage?.getItem(KEY) === "words" ? "words" : "streamdown";
const listeners = new Set<() => void>();

export function setMarkdownRenderer(next: MarkdownRenderer) {
  current = next;
  localStorage.setItem(KEY, next);
  for (const fn of listeners) fn();
}

export function useMarkdownRenderer(): MarkdownRenderer {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}
