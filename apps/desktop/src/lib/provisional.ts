import type { AgentEvent } from "@/types/events";

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
export const retireOldestProvisional = (events: AgentEvent[]) => {
  const i = events.findIndex(isProvisional);
  return i < 0 ? events : [...events.slice(0, i), ...events.slice(i + 1)];
};
