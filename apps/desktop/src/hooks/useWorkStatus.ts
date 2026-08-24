import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import type { WorkStatus } from "@/types/events";

/// Last answer per directory, kept across mounts so switching sessions and
/// coming back draws the row immediately rather than blank and refilling. Not
/// invalidated by anything: every write below is a whole fresh answer, and the
/// key is the directory the answer is about.
const cache = new Map<string, WorkStatus>();

/// What is left to do with this session's work — see [handoffActions].
///
/// Read on the **falling edge of a turn** and on arriving at a session, and
/// nowhere else. Those are the two moments it can change from inside the app:
/// the agent writes, commits and pushes during a turn, and nothing between
/// turns moves the tree except the reader in another window. Polling for that
/// would be several `git` spawns a second to catch something rare — the row
/// going one turn stale is the trade, and the same one every other read in
/// this app makes.
export function useWorkStatus(cwd: string, busy: boolean) {
  const [status, setStatus] = useState<WorkStatus | null>(() => cache.get(cwd) ?? null);

  // Guards a read that outlives the session it started in, so a slow answer
  // can't write one checkout's state under another's name.
  const issued = useRef(0);

  const read = useRef((at: string) => {
    if (!at) return;
    const token = ++issued.current;
    void invoke<WorkStatus>("work_status", { cwd: at })
      .then((next) => {
        cache.set(at, next);
        if (issued.current === token) setStatus(next);
      })
      // Infallible on the Rust side, so anything landing here is the bridge
      // itself. The row draws nothing and that is the honest answer.
      .catch(() => issued.current === token && setStatus(null));
  }).current;

  // Adopt the cache on the way in, then read. Both, because the cached answer
  // is what the reader saw last time and the fresh one is what is true now.
  useEffect(() => {
    setStatus(cache.get(cwd) ?? null);
    read(cwd);
  }, [cwd, read]);

  // The falling edge alone: a turn *starting* changes nothing yet, and reading
  // on every render of a running turn would spawn `git` through the whole of it.
  const wasBusy = useRef(busy);
  useEffect(() => {
    const fell = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (fell) read(cwd);
  }, [busy, cwd, read]);

  // For the push button, which changes all of this without a turn happening —
  // and whose count is the thing on screen the reader is looking at when it
  // lands.
  const refresh = useCallback(() => read(cwd), [cwd, read]);

  return { status, refresh };
}
