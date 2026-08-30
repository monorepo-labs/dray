import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_FOR, isUnsetModel, rememberedModel, UNSET_MODEL, usableModel } from "./model";
import type { Model } from "@/types/events";

const model = (id: string): Model =>
  ({ id, label: id, efforts: [], defaultEffort: null }) as unknown as Model;

const CODEX = [model("gpt56_sol"), model("gpt55")];
const CLAUDE = [model("fable"), model("opus"), model("haiku")];

describe("usableModel", () => {
  it("keeps a pick the harness can run", () => {
    expect(usableModel(CODEX, "gpt55" as never, "codex")).toBe("gpt55");
  });

  /// The whole point: a model stored under the other harness reaches every
  /// seeding path, not only the one that switched harness.
  it("replaces a pick belonging to the other harness", () => {
    expect(usableModel(CODEX, "haiku" as never, "codex")).toBe("gpt56_sol");
  });

  /// The head of the list is a picker-ordering decision. Reading it as an
  /// answer is what put Claude sessions on Fable.
  it("falls back to the harness default, not to whatever leads the list", () => {
    expect(usableModel(CLAUDE, "gpt55" as never, "claude_code")).toBe("opus");
  });

  /// The list arrives a beat after the harness does, and blanking the pick in
  /// that frame would look like the picker forgetting what it was set to.
  it("leaves the pick alone until the list lands", () => {
    expect(usableModel([], "haiku" as never, "codex")).toBe("haiku");
  });
});

describe("rememberedModel", () => {
  /// The bug this exists for: each harness has to answer for itself, or
  /// switching agent and back loses the pick made under the first one.
  it("answers per harness", () => {
    const remembered = { claude_code: "sonnet", codex: "gpt56_luna" } as const;

    expect(rememberedModel(remembered, "claude_code")).toBe("sonnet");
    expect(rememberedModel(remembered, "codex")).toBe("gpt56_luna");
  });

  it("defaults a harness nobody has picked in", () => {
    expect(rememberedModel({ codex: "gpt55" }, "claude_code")).toBe("opus");
    expect(rememberedModel({}, "codex")).toBe("gpt56_sol");
  });

  /// A pick under one harness must not reach the other's default.
  it("does not let one harness's pick answer for the other", () => {
    expect(rememberedModel({ claude_code: "haiku" }, "codex")).toBe("gpt56_sol");
  });
});

describe("the unset model", () => {
  /// pi is multi-provider, so any constant named here might be a model the
  /// reader has no key for. The sentinel is how "let pi decide" is carried.
  it("is what pi opens on, and only pi", () => {
    expect(DEFAULT_MODEL_FOR.pi).toBe(UNSET_MODEL);
    expect(isUnsetModel(DEFAULT_MODEL_FOR.claude_code)).toBe(false);
    expect(isUnsetModel(DEFAULT_MODEL_FOR.codex)).toBe(false);
  });

  /// One spelling, matching `models.rs`. The old `"unknown"` is normalised onto
  /// this before it leaves Rust, so nothing here should ever see that one — and
  /// a surface testing for it would silently stop matching.
  it("has one spelling", () => {
    expect(UNSET_MODEL).toBe("");
    expect(isUnsetModel("unknown" as never)).toBe(false);
  });

  /// The sentinel is not a model, so it can never survive a list that has real
  /// ones in it — it is a stand-in for a pick nobody has made.
  it("gives way once a real list arrives", () => {
    expect(usableModel(CLAUDE, UNSET_MODEL, "claude_code")).toBe("opus");
    // pi names no default of its own, so the head of its discovered list is the
    // only answer left. It is the one place reading the head is right: the list
    // came from pi, and pi orders it.
    expect(usableModel(CODEX, UNSET_MODEL, "pi")).toBe("gpt56_sol");
  });

  /// An empty list means the models have not arrived yet, so nothing is known
  /// well enough to repair the pick. That is pi's resting state until the probe
  /// that discovers its list lands.
  it("stands while the list is empty", () => {
    expect(usableModel([], UNSET_MODEL, "pi")).toBe(UNSET_MODEL);
  });
});
