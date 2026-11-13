import { useCallback, useEffect, useRef, useState } from "react";

import { serverOfBot } from "@/lib/bots";
import { invoke, listen } from "@/lib/transport";
import type { Bot, Routine } from "@/types/events";

/// A bot's routines, read from its server and again on every
/// `routines_changed` it sends, plus once a minute as a reconnect's catch-up.
/// Pause, resume, run and delete go to that same server, and one that fails
/// leaves its reason in `error` until the next succeeds.
export function useRoutines(bot: Bot | null | undefined) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const id = bot?.id;
  const server = bot ? serverOfBot(bot) : null;
  // The bot on screen. A read still out from the one before must not land in
  // its list, or the next Pause acts on a routine the reader can't see.
  const current = useRef("");
  const key = `${server}:${id}`;
  current.current = key;

  const read = useCallback(async () => {
    if (!id || !server) return;
    const list = await invoke<Routine[]>("list_routines", { botId: id }, server).catch(() => null);
    if (list && current.current === `${server}:${id}`) setRoutines(list);
  }, [id, server]);

  useEffect(() => {
    setRoutines([]);
    setError(null);
    if (!server) return;
    void read();
    const changed = listen("routines_changed", (e) => e.server === server && void read());
    const every = window.setInterval(() => void read(), 60_000);
    return () => {
      void changed.then((off) => off());
      window.clearInterval(every);
    };
  }, [read, server]);

  const act = useCallback(
    async (cmd: string, args: Record<string, unknown>, failed: string) => {
      if (!server) return;
      try {
        await invoke(cmd, args, server);
        if (current.current === key) setError(null);
      } catch (e) {
        if (current.current === key) setError(`${failed}: ${e instanceof Error ? e.message : String(e)}`);
      }
      await read();
    },
    [key, read, server],
  );

  return {
    routines,
    error,
    setPaused: (routineId: string, paused: boolean) =>
      act("set_routine_paused", { id: routineId, paused }, paused ? "Couldn't pause it" : "Couldn't resume it"),
    remove: (routineId: string) => act("delete_routine", { id: routineId }, "Couldn't delete it"),
    runNow: (routineId: string) => act("run_routine", { id: routineId }, "Couldn't run it"),
  };
}
