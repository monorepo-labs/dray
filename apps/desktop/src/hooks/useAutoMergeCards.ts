import { useEffect, useMemo, useRef, useState } from "react";

import { greptileClears, useMinGreptileScore } from "@/lib/autoMergeCard";
import { botAt } from "@/lib/bots";
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
/// ready while the app was closed still gets its card. The server picks the
/// chat, since it sees settled sessions this list may not hold, and its log is
/// what keeps it to one card per PR, the agent's own included. `done` here
/// only saves the call, so it is dropped when a bot's chat changes: a fresh
/// chat holds no card yet.
export function useAutoMergeCards({ items, bots, prFor }: Args) {
  const minScore = useMinGreptileScore();
  const done = useRef(new Set<string>());
  /// When Greptile was last asked about each ready PR, while it stays ready.
  const asked = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(false);

  const tasks = useMemo(
    () => items.filter((i) => !i.archived && i.parentSessionId && i.parentSessionId !== i.sessionId),
    [items],
  );
  const botChats = useMemo(
    () => items.filter((i) => !i.archived && botAt(bots, i.cwd)).map((i) => i.sessionId).sort().join("\n"),
    [items, bots],
  );
  useEffect(() => done.current.clear(), [botChats]);

  useEffect(() => {
    const now = Date.now();
    const ready = new Set<string>();
    for (const task of tasks) {
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
          const chat = await invoke<string | null>("auto_merge_card", {
            sessionId: task.sessionId,
            number: mark.number,
            url: mark.url,
            branch,
          });
          // No chat to post in yet is asked again at the next recheck.
          if (chat) done.current.add(key);
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
