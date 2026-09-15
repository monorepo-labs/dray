import type { Harness, Model, ModelId } from "@/types/events";

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
