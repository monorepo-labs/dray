import { invoke, LOCAL, type ServerId } from "@/lib/transport";
import type { AgentEvent, SessionPage, SessionSnapshot } from "@/types/events";

/// A cloud task's transcript kept on this machine, whole, so it opens and
/// scrolls back while its machine is stopped: viewing one never wakes it, only
/// a send does. Written whenever a loaded one stops changing outside a turn.

/// Asks and answers only the child that raised them can act on, and the
/// reconnect's `live_state` redraws any still open.
const UNKEPT = new Set<AgentEvent["payload"]["type"]>(["permission_requested", "questions_asked", "permission_decided"]);

/// What was last written per session, so an unchanged transcript costs nothing.
const written = new Map<string, string>();
/// One save at a time per session: each replaces the file through one temp
/// path, so two at once could leave the older one, or a torn file.
const saves = new Map<string, Promise<unknown>>();

/// `loaded` with the rest of its history in front, so the kept copy reaches
/// the first turn. The copy already on disk supplies it once it does, so only
/// a session's first save pages the machine for older turns.
export async function wholeHistory(
  loaded: SessionSnapshot,
  kept: SessionSnapshot | null,
  page: (before: number) => Promise<SessionPage>,
): Promise<SessionSnapshot> {
  if (loaded.olderBefore == null) return loaded;
  const first = loaded.events[0]?.id;
  const at = kept && kept.olderBefore == null && first ? kept.events.findIndex((e) => e.id === first) : -1;
  if (kept && at >= 0) return { ...loaded, events: [...kept.events.slice(0, at), ...loaded.events], olderBefore: null };
  let events = loaded.events;
  let before: number | null = loaded.olderBefore;
  while (before != null) {
    const older = await page(before);
    events = [...older.events, ...events];
    before = older.olderBefore;
  }
  return { ...loaded, events, olderBefore: null };
}

export function keepCloudTranscript(server: ServerId, snapshot: SessionSnapshot): void {
  const id = snapshot.sessionId;
  const mark = `${snapshot.events.length}:${snapshot.events.at(-1)?.id ?? ""}:${snapshot.title}`;
  if (written.get(id) === mark) return;
  written.set(id, mark);
  const next = (saves.get(id) ?? Promise.resolve())
    .then(async () => {
      const kept = await keptCloudTranscript(server, id);
      const page = (before: number) =>
        invoke<SessionPage>("get_session_page", { sessionId: id, before, turns: 64 }, server);
      // The machine may be gone by now; the loaded part is still worth keeping.
      const whole = await wholeHistory(snapshot, kept, page).catch(() => snapshot);
      const events = whole.events.filter((e) => !UNKEPT.has(e.payload.type));
      await invoke("save_cloud_transcript", { server, sessionId: id, snapshot: { ...whole, events } }, LOCAL);
    })
    .catch(() => written.delete(id));
  saves.set(id, next);
}

export const keptCloudTranscript = (server: ServerId, sessionId: string): Promise<SessionSnapshot | null> =>
  invoke<SessionSnapshot | null>("cloud_transcript", { server, sessionId }, LOCAL).catch(() => null);
