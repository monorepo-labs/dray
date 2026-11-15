import { useEffect, useState } from "react";

import { readPreviews } from "@/lib/bots";
import { lastMessageLine } from "@/lib/stalled";

/// How long a waiting row waits on its task's server for the last message. A
/// stopped or asleep machine may never answer, and the row must not hold its
/// skeleton for it.
export const READ_TIMEOUT_MS = 8_000;

/// How soon a read that failed is tried again while its row is on screen, so a
/// machine waking up fills the row in.
const RETRY_MS = 60_000;

const ANSWERED_CAP = 200;

/// Lines read, by stall key; `null` where the task wrote nothing. A key names
/// one stall, so a task that moves is read afresh.
const answered = new Map<string, string | null>();
/// Reads still running, by stall key. Kept until the read settles rather than
/// until it times out, so a retry joins a read that hangs instead of stacking
/// another beside it.
const inFlight = new Map<string, Promise<string | null | undefined>>();

/// The task's last message as one line; `undefined` where its server failed or
/// did not answer in time.
export function readStallLine(key: string, sessionId: string): Promise<string | null | undefined> {
  let read = inFlight.get(key);
  if (!read) {
    // `readPreviews` drops a server that errors, so a missing entry is a failure.
    read = readPreviews([sessionId])
      .then((p) => (p[sessionId] ? (lastMessageLine(p[sessionId].text) ?? null) : undefined))
      .then((found) => {
        if (found !== undefined) {
          answered.set(key, found);
          if (answered.size > ANSWERED_CAP) answered.delete(answered.keys().next().value!);
        }
        return found;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, read);
  }
  const timeout = new Promise<undefined>((done) => setTimeout(done, READ_TIMEOUT_MS));
  return Promise.race([read, timeout]);
}

/// A waiting row's line until its bot writes a need (`dray session need`),
/// which may never come: the nudge or the write can fail on a task's machine
/// that is stopped or asleep, and a bot can judge there is nothing to add.
/// `reading` holds the skeleton for one read of the task's last message, at
/// most [READ_TIMEOUT_MS]; then `line` is that message, or `null` for none.
export function useStallLine(key: string, sessionId: string, on: boolean): { reading: boolean; line: string | null } {
  const [read, setRead] = useState<{ key: string; line: string | null } | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!on || answered.has(key)) return;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void readStallLine(key, sessionId).then((line) => {
      if (!live) return;
      setRead({ key, line: line ?? null });
      if (line === undefined) retry = setTimeout(() => setTries((n) => n + 1), RETRY_MS);
    });
    return () => {
      live = false;
      clearTimeout(retry);
    };
  }, [on, key, sessionId, tries]);

  const cached = answered.get(key);
  if (cached !== undefined) return { reading: false, line: cached };
  if (read?.key === key) return { reading: false, line: read.line };
  return { reading: on, line: null };
}
