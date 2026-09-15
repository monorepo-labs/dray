import { describe, expect, it } from "vitest";

import { fastFor, fastNotice, offersFast } from "./fastMode";
import type { AgentEvent, Harness, Model, ModelId } from "@/types/events";

function model(id: string, supportsFast: boolean): Model {
  return {
    id: id as ModelId,
    label: id,
    efforts: [],
    defaultEffort: null,
    arg: id,
    provider: "",
    acceptsImages: true,
    secondary: false,
    supportsFast,
  };
}

const OPUS = model("opus", true);
const HAIKU = model("haiku", false);

describe("offersFast", () => {
  it("draws the row only where the harness has a route to one", () => {
    const has: Harness[] = ["claude_code", "codex", "fx"];
    for (const harness of has) {
      expect(offersFast(harness, OPUS, true)).toBe(true);
    }
    expect(offersFast("pi", OPUS, true)).toBe(false);
  });

  /// Codex takes an unknown `serviceTier` with no error at all, so a row drawn
  /// over a model with no faster tier is a switch indistinguishable from one
  /// that works.
  it("draws nothing for a model with no faster tier", () => {
    expect(offersFast("claude_code", HAIKU, true)).toBe(false);
    expect(offersFast("claude_code", null, true)).toBe(false);
  });

  /// fx stamps `fast_mode` onto its own session record at `session/new` and a
  /// resume honours the stamp, so a session that exists can never be moved —
  /// not even by replacing the child.
  it("drops fx's row once the session exists, and keeps the others", () => {
    expect(offersFast("fx", OPUS, false)).toBe(false);
    expect(offersFast("claude_code", OPUS, false)).toBe(true);
    expect(offersFast("codex", OPUS, false)).toBe(true);
  });
});

describe("fastFor", () => {
  /// The pick survives a switch to a model that cannot honour it — the same
  /// bargain `effortByModel` makes — so what goes out has to be read against
  /// the model on screen every time rather than off the stored value.
  it("sends nothing a model or harness cannot honour", () => {
    const models = [OPUS, HAIKU];
    expect(fastFor(true, "claude_code", models, OPUS.id)).toBe(true);
    expect(fastFor(true, "claude_code", models, HAIKU.id)).toBe(false);
    expect(fastFor(true, "pi", models, OPUS.id)).toBe(false);
    expect(fastFor(false, "claude_code", models, OPUS.id)).toBe(false);
  });

  /// A list still being read leaves the pick unfound, which must answer no: a
  /// `true` reaching the index for a model nothing here can name is the state
  /// the clamp exists to prevent.
  it("answers no while the model list is empty", () => {
    expect(fastFor(true, "claude_code", [], OPUS.id)).toBe(false);
  });
});

/// "Let fx decide" is fx's *ordinary* pick, not a gap — Dray names no default
/// for a multi-provider CLI — and fx applies fast mode per model itself. So the
/// unset model must not be what hides the row there, where on the two harnesses
/// that answer per model it has to.
describe("an unset model", () => {
  it("keeps fx's row and hides the others", () => {
    expect(offersFast("fx", null, true)).toBe(true);
    expect(fastFor(true, "fx", [], "" as ModelId)).toBe(true);

    expect(offersFast("codex", null, true)).toBe(false);
    expect(fastFor(true, "codex", [], "" as ModelId)).toBe(false);
  });
});

/// The notice is what stands between a lit switch and a turn that ran at
/// ordinary speed, so what matters is both that it is said and that it stops
/// being said.
describe("the harness's own word about fast mode", () => {
  const ev = (payload: object) => ({ payload }) as AgentEvent;
  const REFUSED = "Fast mode disabled · usage credits exhausted";
  const notice = ev({ type: "fast_mode_notice", text: REFUSED });
  const turn = ev({ type: "turn_started" });
  const text = ev({ type: "assistant_text", text: "hi" });

  it("says nothing where the harness did", () => {
    expect(fastNotice([])).toBe(null);
    expect(fastNotice([turn, text])).toBe(null);
  });

  it("carries the sentence through the rest of the turn", () => {
    expect(fastNotice([turn, notice, text])).toBe(REFUSED);
  });

  /// The clearing rule. A turn that refuses says so again, so a turn that says
  /// nothing is a turn that ran fast — and the notice must not outlive it.
  it("clears on a turn that says nothing", () => {
    expect(fastNotice([turn, notice, text, turn, text])).toBe(null);
    expect(fastNotice([turn, notice, turn, notice])).toBe(REFUSED);
  });
});
