import { useEffect, useMemo, useRef, useState } from "react";

import { readyForCard } from "@/lib/autoMergeCard";
import { botAt } from "@/lib/bots";
import { sessionBranch } from "@/lib/pr";
import { invoke, LOCAL, serverOfPath, serverOfSession } from "@/lib/transport";
import type { Bot, PrMark, SessionIndexItem } from "@/types/events";

/// How long a ready PR whose card could not go up waits before it is tried
/// again: a failed call, or a task whose chat is settled for now.
const RETRY_MS = 3 * 60_000;
/// How often pending PRs are looked at, so a retry comes due without a mark moving.
const TICK_MS = 60_000;

type Args = {
  items: SessionIndexItem[];
  bots: readonly Bot[];
  prFor: (repoPath: string, branch: string | null) => PrMark | undefined;
};

/// Posts a merge card in the chat that started a task once GitHub says the
/// task's PR can merge (`readyForCard`).
///
/// **State, not transition**, unlike the Ready to merge notice: a PR that turned
/// ready while the app was closed still gets its card. The server picks the
/// chat, since it sees settled sessions this list may not hold, and its log is
/// what keeps it to one card per PR, the agent's own included. `done` here
/// only saves the call, so it is dropped when a bot's chat changes: a fresh
/// chat holds no card yet.
export function useAutoMergeCards({ items, bots, prFor }: Args) {
  const done = useRef(new Set<string>());
  /// When each ready PR was last tried, while it stays ready.
  const tried = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(false);

  const tasks = useMemo(
    () => items.filter((i) => !i.archived && i.parentSessionId && i.parentSessionId !== i.sessionId),
    [items],
  );
  const listed = useMemo(() => new Set(items.map((i) => i.sessionId)), [items]);
  const botServers = useMemo(() => [...new Set(bots.map((b) => serverOfPath(b.path)))], [bots]);
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
      if (!branch || !mark || !readyForCard(mark)) continue;
      const key = mark.url;
      if (done.current.has(key)) continue;
      ready.add(key);
      if (inFlight.current.has(key) || now - (tried.current.get(key) ?? 0) < RETRY_MS) continue;

      inFlight.current.add(key);
      tried.current.set(key, now);
      // To the chat's server, which finds a task on another machine itself. A
      // parent no list here holds — a bot chat Start fresh settled — is asked
      // of each server that could own it, until one answers with a chat.
      const parentId = task.parentSessionId as string;
      const servers = listed.has(parentId)
        ? [serverOfSession(parentId)]
        : [...new Set([serverOfSession(task.sessionId), ...botServers, LOCAL])];
      const args = { sessionId: parentId, taskId: task.sessionId, number: mark.number, url: mark.url, branch };
      void (async () => {
        for (const server of servers) {
          const chat = await invoke<string | null>("auto_merge_card", args, server).catch(() => null);
          if (chat) return done.current.add(key);
        }
        // No chat to post in yet is tried again later, as is a failed call.
      })().finally(() => inFlight.current.delete(key));
    }
    // A PR that stops being ready is tried at once when it comes back.
    for (const key of tried.current.keys()) if (!ready.has(key)) tried.current.delete(key);
    setPending(ready.size > 0);
  }, [tasks, listed, botServers, prFor, tick]);

  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, [pending]);
}
