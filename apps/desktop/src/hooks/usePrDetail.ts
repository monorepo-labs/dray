import { useCallback, useEffect, useRef, useState } from "react";

import { asUnavailable } from "@/lib/pr";
import { invoke } from "@/lib/transport";
import type { PrDetail, PrUnavailable } from "@/types/events";

/// Last answer per PR url and the `updatedAt` it was read at, kept across
/// picks so reopening a PR paints at once.
const cache = new Map<string, { at: string; detail: PrDetail }>();

export type PrDetailRead = ReturnType<typeof usePrDetail>;

/// One pull request's description, labels and reviewers, for the pull
/// requests page's pane. `pr` is `null` while nothing is picked.
///
/// Read on pick, and again only when the PR moved (`updatedAt`) or on
/// refresh — never on a timer: the pane's other read already polls, and this
/// one would spend a point of the GitHub budget every agent shares on an
/// answer that rarely changes.
export function usePrDetail(pr: { cwd: string; number: number; url: string; updatedAt: string } | null) {
  // Each answer carries the url it is for. The hook lives in `App` across
  // picks, so a plain value would draw the last PR's description under the
  // new one's header for the frame before the effect below runs.
  const [read, setRead] = useState<{ url: string; detail?: PrDetail; error?: PrUnavailable } | null>(null);
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  const honoured = useRef(0);

  const { cwd, number, url, updatedAt } = pr ?? { cwd: "", number: 0, url: "", updatedAt: "" };
  useEffect(() => {
    const forced = generation !== honoured.current;
    honoured.current = generation;
    if (!url) return;
    const cached = cache.get(url);
    if (!forced && cached?.at === updatedAt) return;
    let gone = false;
    setLoading(true);
    invoke<PrDetail>("pr_detail", { cwd, number })
      .then((answer) => {
        cache.set(url, { at: updatedAt, detail: answer });
        if (!gone) setRead({ url, detail: answer });
      })
      .catch((e) => !gone && setRead({ url, error: asUnavailable(e) }))
      .finally(() => !gone && setLoading(false));
    return () => {
      gone = true;
      setLoading(false);
    };
  }, [cwd, number, url, updatedAt, generation]);

  const refresh = useCallback(() => setGeneration((n) => n + 1), []);
  const own = read?.url === url ? read : null;
  return {
    // A fresh answer, else the cached one: a refresh that failed keeps
    // what was already read on screen beside its error.
    detail: own?.detail ?? (url ? (cache.get(url)?.detail ?? null) : null),
    error: own?.error ?? null,
    loading,
    refresh,
  };
}
