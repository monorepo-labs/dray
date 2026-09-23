import type { Harness } from "@/types/events";

export type Control = "model" | "effort" | "stance" | "fast";

/// Which composer controls each harness can apply to the prompt sent next while
/// a turn is running, measured against each CLI. The other half of `send_msg`'s
/// mid-turn gate in session.rs, stated twice because neither side can call the
/// other.
///
/// Claude Code's effort and the stance on grok and pi respawn the child, which
/// cannot happen under a running turn. Codex steers a queued prompt into the
/// running turn and ignores its model. fx refuses every change mid-prompt, but
/// its queued prompt is the next turn, so its picks wait for that turn.
const LIVE: Record<Harness, readonly Control[]> = {
  claude_code: ["model", "stance", "fast"],
  grok: ["model", "effort", "fast"],
  pi: ["model", "effort"],
  fx: ["model", "effort", "stance"],
  codex: [],
};

/// Locked while a turn runs where the harness cannot apply the control to the
/// next prompt — moved anyway, it would skip that prompt and land on the one
/// after, with nothing on screen saying so.
export function lockedMidTurn(harness: Harness, control: Control, busy: boolean): boolean {
  return busy && !LIVE[harness].includes(control);
}
