import { useCallback, useState } from "react";

import { invoke, LOCAL, type ServerId } from "@/lib/transport";

const NOTHING: ReadonlySet<string> = new Set();

/// The sessions on other machines that `server` can message, as it last said.
/// Read only when the `&` picker opens, since on a machine with links of its own
/// the answer asks every one of them. A server too old to answer reaches only
/// itself, as far as anyone can tell here.
export function useReachableSessions(server: ServerId) {
  const [answers, setAnswers] = useState<Record<ServerId, ReadonlySet<string>>>({});

  const refresh = useCallback(() => {
    if (server === LOCAL) return;
    invoke<string[]>("reachable_sessions", {}, server).then(
      (ids) => setAnswers((held) => ({ ...held, [server]: new Set(ids) })),
      () => {},
    );
  }, [server]);

  return { reachable: answers[server] ?? NOTHING, refresh };
}
