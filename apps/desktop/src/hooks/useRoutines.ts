import { useCallback, useEffect, useState } from "react";

import { serverOfBot } from "@/lib/bots";
import { invoke, listen } from "@/lib/transport";
import type { Bot, Routine } from "@/types/events";

/// A bot's routines, read from its server and again on every
/// `routines_changed` it sends, plus once a minute as a reconnect's catch-up.
/// Pause, resume, run and delete go to that same server.
export function useRoutines(bot: Bot | null | undefined) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const id = bot?.id;
  const server = bot ? serverOfBot(bot) : null;

  const read = useCallback(async () => {
    if (!id || !server) return;
    const list = await invoke<Routine[]>("list_routines", { botId: id }, server).catch(() => null);
    if (list) setRoutines(list);
  }, [id, server]);

  useEffect(() => {
    setRoutines([]);
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
    async (cmd: string, args: Record<string, unknown>) => {
      if (!server) return;
      await invoke(cmd, args, server);
      await read();
    },
    [read, server],
  );

  return {
    routines,
    setPaused: (routineId: string, paused: boolean) => act("set_routine_paused", { id: routineId, paused }),
    remove: (routineId: string) => act("delete_routine", { id: routineId }),
    runNow: (routineId: string) => act("run_routine", { id: routineId }),
  };
}
