import type { AgentEvent, ImageRef } from "@/types/events";

/// The user's own prompt, drawn before the backend has answered for the session.
///
/// A `send_msg` resolves only once the worktree is made, the child spawned and
/// the harness has taken the prompt, and the real `user_message` is minted at
/// the far end of that wait — 1–2s on pi and Codex in a worktree, 1–5s on an fx
/// resume, which respawns `fx acp`, hands it the MCP list and blocks on
/// `session/resume`. Without a row the sentence is nowhere on screen for the
/// whole window.
///
/// The rules live here rather than in `useSessions` because being wrong about
/// any of them is invisible on screen until something else sorts or merges.
export const PROVISIONAL_PREFIX = "provisional:";

export const isProvisional = (e: AgentEvent) => e.id.startsWith(PROVISIONAL_PREFIX);

/// One per *send*, never one per session: the composer stays live through the
/// wait, so a second prompt can be typed and sent while the first is still out.
/// Sharing an id there gave the transcript two rows under one React key and let
/// either send's answer take the other's row away.
export const provisionalId = () => `${PROVISIONAL_PREFIX}${crypto.randomUUID()}`;

/// Past every main-thread event the session holds, so a merge that sorts — a
/// snapshot arriving while the row is up — cannot lift it above the history it
/// was typed under.
///
/// Subagent events are skipped rather than counted. Their `seq` is a counter of
/// their own starting at 0 (`get_subagent_seq` in the Claude Code mapper), so
/// one appended last says nothing about where the main thread has got to — and
/// reading the tail event's `seq` put a prompt typed at main-thread 41 in at 1.
///
/// Reduced rather than spread: a long session's event list is past what an
/// argument list takes.
export const nextMainSeq = (events: AgentEvent[]) =>
  events.reduce((max, e) => (e.subagent || e.seq <= max ? max : e.seq), -1) + 1;

/// The real prompt retires the *oldest* provisional, not every one: prompts are
/// delivered in the order they were sent, so the head of the line is the one
/// this event is the answer to. Taking them all would blank a prompt still
/// waiting on a send of its own.
///
/// `by` is the real prompt doing the retiring, which takes over the row and
/// the pictures the provisional one drew — see [rowId] and [carryPreviews].
export const retireOldestProvisional = (events: AgentEvent[], by?: AgentEvent) => {
  const i = events.findIndex(isProvisional);
  if (i < 0) return events;
  if (by) takeOver(events[i], by);
  return [...events.slice(0, i), ...events.slice(i + 1)];
};

/// Real prompt's id → the provisional one it replaced.
const tookOver = new Map<string, string>();

/// The key a prompt's row is drawn under: the provisional one's, once the real
/// prompt has replaced it. Keyed on its own id, the row remounted at that
/// moment, and every picture in it was a new element painting from nothing.
export const rowId = (e: AgentEvent) => tookOver.get(e.id) ?? e.id;

/// The real prompt `to` taking over the provisional `from`'s row and pictures.
export function takeOver(from: AgentEvent, to: AgentEvent) {
  tookOver.set(to.id, from.id);
  carryPreviews(from, to);
}

/// Archived path → the `data:` URL the composer already drew that picture from.
/// Oldest first, so the cap drops the picture sent longest ago.
const carried = new Map<string, string>();
/// Each entry can be megabytes, and only a just-sent row gains from one: past
/// the first draw, the archived file is already in the image cache.
const CARRIED_MAX = 12;

/// Lets the real prompt's pictures draw from the bytes the provisional one held.
///
/// The real `user_message` names archived copies, which load through the server,
/// so for a moment every picture sent was blank. The same `data:` URL is one
/// the document has already decoded, so the row draws it at once.
///
/// Paired by position, which holds because both lists are the attachments that
/// travel as images, in the order they were pinned. A count that differs says
/// the two are not one send, and nothing is carried.
export function carryPreviews(from: AgentEvent, to: AgentEvent) {
  carryImages(from.payload.type === "user_message" ? from.payload.images : [], to);
}

/// [carryPreviews] from a list of pictures rather than an event — a queued
/// prompt's row, which holds its attachments rather than a provisional event.
export function carryImages(from: ImageRef[], to: AgentEvent) {
  if (to.payload.type !== "user_message" || from.length !== to.payload.images.length) return;
  to.payload.images.forEach((image, i) => {
    const url = from[i].url;
    if (!image.path || !url?.startsWith("data:")) return;
    carried.delete(image.path);
    carried.set(image.path, url);
  });
  for (const path of carried.keys()) {
    if (carried.size <= CARRIED_MAX) break;
    carried.delete(path);
  }
}

/// The picture already held for an archived attachment, or `undefined`.
export const carriedPreview = (path: string) => carried.get(path);
