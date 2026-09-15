import type { AgentEvent, Harness, Model, ModelId } from "@/types/events";

/// When a fast-mode pick can reach the child, per harness.
///
/// Stated twice — `Capabilities::fast_mode` in `harness/harness.rs` is the
/// other half — because neither side can call the other, the same bargain
/// `DEFAULT_MODEL_FOR` and `stanceFor` already make. What must not happen is
/// two *different* rules: the backend's decides what the child is told, and
/// this one decides whether the reader is offered the switch at all, so a
/// disagreement is a control that does nothing or a setting with no control.
///
/// - `in-place` — Claude Code. `apply_flag_settings` moves a running child.
/// - `on-spawn` — Codex. `serviceTier` rides the spawn, so a change respawns.
/// - `at-creation` — fx. It reads `fast_mode` out of its settings at
///   `session/new` and stamps it onto its own session record, which a resume
///   then honours whatever the file says since — so nothing, not even a
///   respawn, can move a session that already exists.
/// - `none` — pi, which has no route to one.
export type FastModeSupport = "none" | "in-place" | "on-spawn" | "at-creation";

export const FAST_MODE_BY_HARNESS: Record<Harness, FastModeSupport> = {
  claude_code: "in-place",
  codex: "on-spawn",
  fx: "at-creation",
  pi: "none",
};

/// Whether a harness's fast mode stands even with no model picked.
///
/// fx alone, and it falls out of the same fact its `supportsFast` does: fx
/// decides per model itself ("when the model supports it") and publishes no
/// list, so Dray never knows which. A pick of "let fx decide" is therefore
/// exactly as able to run fast as any named model — and it is the *ordinary*
/// state there, since Dray names no default for a multi-provider CLI whose own
/// settings already hold one. The other two answer no: with no model named,
/// nothing here can tell, and Codex takes an unknown tier without complaint.
function standsWithNoModel(harness: Harness): boolean {
  return FAST_MODE_BY_HARNESS[harness] === "at-creation";
}

/// Whether the composer draws the fast-mode row at all.
///
/// Three things have to hold together, and each removes a different lie. The
/// *harness* must have a route to one. The *model* must have a faster tier —
/// Claude Code offers fast mode on Opus alone, and Codex answers it row by row
/// — since Codex accepts an unknown `serviceTier` with no error, which makes a
/// wrongly drawn switch indistinguishable from a working one. And an fx session
/// that already exists can never be moved, so the row goes once one has started
/// rather than sitting there lit and inert.
export function offersFast(
  harness: Harness,
  model: Model | null | undefined,
  isNewSession: boolean,
): boolean {
  const support = FAST_MODE_BY_HARNESS[harness] ?? "none";
  if (support === "none") return false;
  if (support === "at-creation" && !isNewSession) return false;
  return model?.supportsFast ?? standsWithNoModel(harness);
}

/// What actually gets sent, given the reader's pick.
///
/// The pick is per session and survives a model switch, so it has to be read
/// against the model on screen every time: switching Opus → Haiku with fast on
/// must send `false`, not carry a setting Haiku has nothing to do with. The
/// backend clamps by *harness* for the same reason; this is the model half,
/// which only the frontend holds.
export function fastFor(
  fast: boolean,
  harness: Harness,
  models: Model[],
  modelId: ModelId,
): boolean {
  if (!fast) return false;
  const support = FAST_MODE_BY_HARNESS[harness] ?? "none";
  if (support === "none") return false;
  return models.find((m) => m.id === modelId)?.supportsFast ?? standsWithNoModel(harness);
}

/// The harness's own word about fast mode this turn, or `null` where it said
/// nothing.
///
/// Read back out of the log rather than tracked, the same bargain the context
/// ring makes: the notice is already persisted, so a session reopened days
/// later reads the same answer it did live.
///
/// Scoped to the newest turn, which is what clears it — Claude Code says this
/// once per **turn** it refuses, not once per session, so a turn that runs fast
/// says nothing and the walk stops at its `turn_started` having found no
/// notice. Captured: two lines 8s apart in one session, which is the whole
/// reason this walk may stop there. Read it as once-per-session and the stop is
/// a bug to simplify away — and then the newest notice stands for the rest of
/// the session, which cannot heal: a cooldown ends, credits get topped up, and
/// the sentence sits there saying otherwise.
///
/// Known ceiling: a compaction opens a fresh `init` mid-turn, so one landing
/// after a refusal clears the notice until the next refusal re-raises it. Left
/// alone deliberately — the stop is aligned with what the CLI emits against,
/// which is the turn it opened and not the prompt the reader typed, and a
/// boundary of our own would be a second answer to a question the emitter has
/// already answered.
///
/// Deliberately not read from `turn_started`'s own `settings.fastMode`. That
/// field is not a weaker source but a lying one: measured, it said `on` through
/// both turns of the capture the CLI refused.
export function fastNotice(events: AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i].payload;
    if (p.type === "fast_mode_notice") return p.text;
    if (p.type === "turn_started") return null;
  }
  return null;
}
