import { invoke, LOCAL, type ServerId } from "@/lib/transport";
import type { AgentEvent, SessionSnapshot } from "@/types/events";

/// A cloud task's transcript kept on this machine, so it opens while its
/// machine is stopped: viewing one never wakes it, only a send does. Written
/// whenever a loaded one stops changing, read back when its machine is down.

/// Asks and answers only the child that raised them can act on, and the
/// reconnect's `live_state` redraws any still open.
const UNKEPT = new Set<AgentEvent["payload"]["type"]>(["permission_requested", "questions_asked", "permission_decided"]);

/// What was last written per session, so an unchanged transcript costs nothing.
const written = new Map<string, string>();

export function keepCloudTranscript(server: ServerId, snapshot: SessionSnapshot): void {
  const last = snapshot.events.at(-1);
  const mark = `${snapshot.events.length}:${last?.id ?? ""}:${snapshot.title}`;
  if (written.get(snapshot.sessionId) === mark) return;
  written.set(snapshot.sessionId, mark);
  const kept = { ...snapshot, events: snapshot.events.filter((e) => !UNKEPT.has(e.payload.type)) };
  invoke("save_cloud_transcript", { server, sessionId: snapshot.sessionId, snapshot: kept }, LOCAL).catch(() =>
    written.delete(snapshot.sessionId),
  );
}

export const keptCloudTranscript = (server: ServerId, sessionId: string): Promise<SessionSnapshot | null> =>
  invoke<SessionSnapshot | null>("cloud_transcript", { server, sessionId }, LOCAL).catch(() => null);
