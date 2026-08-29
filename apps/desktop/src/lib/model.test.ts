import { describe, expect, it } from "vitest";
import { rememberedModel, usableModel } from "./model";
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
