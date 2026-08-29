import { describe, expect, it } from "vitest";
import { usableModel } from "./model";
import type { Model } from "@/types/events";

const model = (id: string): Model =>
  ({ id, label: id, efforts: [], defaultEffort: null }) as unknown as Model;

const CODEX = [model("gpt-5.6-sol"), model("gpt-5.5")];

describe("usableModel", () => {
  it("keeps a pick the harness can run", () => {
    expect(usableModel(CODEX, "gpt-5.5" as never)).toBe("gpt-5.5");
  });

  /// The whole point: a model stored under the other harness reaches every
  /// seeding path, not only the one that switched harness.
  it("replaces a pick belonging to the other harness", () => {
    expect(usableModel(CODEX, "haiku" as never)).toBe("gpt-5.6-sol");
  });

  /// The list arrives a beat after the harness does, and blanking the pick in
  /// that frame would look like the picker forgetting what it was set to.
  it("leaves the pick alone until the list lands", () => {
    expect(usableModel([], "haiku" as never)).toBe("haiku");
  });
});
