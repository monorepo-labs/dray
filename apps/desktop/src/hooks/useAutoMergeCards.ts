import { useEffect, useMemo, useRef, useState } from "react";

import { cardChat, greptileClears, useMinGreptileScore } from "@/lib/autoMergeCard";
import { prStatus, sessionBranch } from "@/lib/pr";
import { invoke } from "@/lib/transport";
import type { Bot, GreptileReview, PrMark, SessionIndexItem } from "@/types/events";

/// How long a ready PR Greptile has not cleared waits before Greptile is asked
/// again. Its re-review lands minutes after a push and moves no mark, so only
/// this finds it; every ask spends the `gh` budget agents share.
const RECHECK_MS = 3 * 60_000;
/// How often pending PRs are looked at, so a recheck comes due without a mark moving.
const TICK_MS = 60_000;

type Args = {
  items: SessionIndexItem[];
  bots: readonly Bot[];
  prFor: (repoPath: string, branch: string | null) => PrMark | undefined;
};

/// Posts a merge card in the chat that started a task once the task's PR is
/// ready: `prStatus` says ready and Greptile clears it (`greptileClears`).
///
/// **State, not transition**, unlike the Ready to merge notice: a PR that turned
/// ready while the app was closed still gets its card. The chat's log is what
/// keeps it to one per PR — `auto_merge_card` posts nothing where a card for
/// it is already there, the agent's own included — so `done` here only saves
/// the call.
export function useAutoMergeCards({ items, bots, prFor }: Args) {
  const minScore = useMinGreptileScore();
  const done = useRef(new Set<string>());
  /// When Greptile was last asked about each ready PR, while it stays ready.
  const asked = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(false);

  const tasks = useMemo(() => {
    const byId = new Map(items.map((i) => [i.sessionId, i]));
    return items.flatMap((task) => {
      const chatId = cardChat(task, byId, items, bots);
      return chatId ? [{ task, chatId }] : [];
    });
  }, [items, bots]);

  useEffect(() => {
    const now = Date.now();
    const ready = new Set<string>();
    for (const { task, chatId } of tasks) {
      const branch = sessionBranch(task);
      const mark = prFor(task.projectPath, branch);
      if (!branch || !mark || mark.state !== "OPEN" || prStatus(mark).key !== "ready") continue;
      const key = `${task.projectPath}#${mark.number}`;
      if (done.current.has(key)) continue;
      ready.add(key);
      if (inFlight.current.has(key) || now - (asked.current.get(key) ?? 0) < RECHECK_MS) continue;

      inFlight.current.add(key);
      asked.current.set(key, now);
      void (async () => {
        try {
          const review = await invoke<GreptileReview>("greptile_review", { cwd: task.projectPath, number: mark.number });
          if (!greptileClears(review, minScore)) return;
          await invoke<boolean>("auto_merge_card", {
            sessionId: chatId,
            taskId: task.sessionId,
            number: mark.number,
            url: mark.url,
            branch,
          });
          done.current.add(key);
        } catch {
          // A failed read or post is asked again at the next recheck.
        } finally {
          inFlight.current.delete(key);
        }
      })();
    }
    // A PR that stops being ready is asked about at once when it comes back.
    for (const key of asked.current.keys()) if (!ready.has(key)) asked.current.delete(key);
    setPending(ready.size > 0);
  }, [tasks, prFor, minScore, tick]);

  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, [pending]);
}
