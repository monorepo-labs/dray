import { describe, expect, it } from "vitest";

import {
  byProvider,
  defaultStars,
  matchesQuery,
  seedKey,
  shortlist,
  toggleStar,
} from "./starredModels";
import type { Model, ModelId } from "@/types/events";

function model(id: string, over: Partial<Model> = {}): Model {
  const [provider, label] = id.split("/");
  return {
    id: id as ModelId,
    label: label ?? id,
    efforts: [],
    defaultEffort: null,
    arg: label ?? id,
    provider: provider ?? "",
    acceptsImages: true,
    secondary: false,
    supportsFast: false,
    ...over,
  };
}

const XAI = model("xai/grok-4.6");
const SPARK = model("openai-codex/gpt-5.3-codex-spark");
const SOL = model("openai-codex/gpt-5.6-sol");

describe("shortlist", () => {
  it("keeps the starred models in the list's own order", () => {
    const drawn = shortlist([XAI, SPARK, SOL], [SOL.id, XAI.id], "" as ModelId);

    expect(drawn.map((m) => m.id)).toEqual([XAI.id, SOL.id]);
  });

  /// A session already running on a model reads its own name off this list.
  /// Unstarring it mid-session would leave the trigger naming a model the menu
  /// says nothing about.
  it("draws the session's own model whether or not it is starred", () => {
    const drawn = shortlist([XAI, SPARK, SOL], [SOL.id], SPARK.id);

    expect(drawn.map((m) => m.id)).toEqual([SPARK.id, SOL.id]);
  });

  /// Logging a provider out is a state that ends. Dropping the star would make
  /// the reader set it up again on the way back.
  it("draws nothing for a star no provider currently serves", () => {
    const drawn = shortlist([XAI], ["xai/grok-4.6", "gone/model"] as ModelId[], "" as ModelId);

    expect(drawn.map((m) => m.id)).toEqual([XAI.id]);
  });

  it("draws nothing at all before anything is starred", () => {
    expect(shortlist([XAI, SPARK], [], "" as ModelId)).toEqual([]);
  });
});

describe("byProvider", () => {
  it("gathers each provider once, in the order the list arrived in", () => {
    const groups = byProvider([SPARK, XAI, SOL]);

    expect(groups.map((g) => g.provider)).toEqual(["openai-codex", "xai"]);
    expect(groups[0].models.map((m) => m.id)).toEqual([SPARK.id, SOL.id]);
  });
});

describe("toggleStar", () => {
  it("adds a missing star and removes a present one", () => {
    expect(toggleStar([], XAI.id)).toEqual([XAI.id]);
    expect(toggleStar([XAI.id, SOL.id], XAI.id)).toEqual([SOL.id]);
  });
});

describe("defaultStars", () => {
  /// One needle answers for both spellings: the gateway prefixes a model with
  /// its vendor where fx's own providers name it bare.
  it("matches a whole id and a last segment alike", () => {
    const gateway = [model("openai/gpt-5.6-sol"), model("spacexai/grok-4.6")];
    expect(defaultStars("fx", "gateway", gateway)).toEqual([
      "openai/gpt-5.6-sol",
      "spacexai/grok-4.6",
    ]);
    expect(defaultStars("fx", "grok", [model("grok-4.6")])).toEqual(["grok-4.6"]);
  });

  /// A needle naming nothing the provider serves seeds nothing, which is the
  /// state the picker was in before defaults existed.
  it("seeds only what the list holds", () => {
    expect(defaultStars("fx", "codex", [SPARK])).toEqual([]);
    expect(defaultStars("fx", "codex", [model("gpt-5.6-sol"), SPARK])).toEqual([
      "gpt-5.6-sol",
    ]);
    expect(defaultStars("fx", "nobody", [model("gpt-5.6-sol")])).toEqual([]);
  });

  /// The written lists seed what used to be their top level; `secondary` is
  /// what used to fold a row under "More models".
  it("stars a written list's non-secondary rows", () => {
    const claude = [model("fable"), model("opus"), model("haiku", { secondary: true })];
    expect(defaultStars("claude_code", "", claude)).toEqual(["fable", "opus"]);
    expect(defaultStars("codex", "", claude)).toEqual(["fable", "opus"]);
  });

  it("seeds nothing for pi", () => {
    expect(defaultStars("pi", "xai", [XAI])).toEqual([]);
  });
});

describe("seedKey", () => {
  /// fx has providers named after the other harnesses, and a shared marker
  /// would let seeding one skip the other.
  it("keeps fx providers and harnesses apart", () => {
    expect(seedKey("fx", "codex")).toBe("codex");
    expect(seedKey("codex", "")).toBe("harness:codex");
  });
});

describe("matchesQuery", () => {
  it("matches nothing away when the query is blank", () => {
    expect(matchesQuery(XAI, "")).toBe(true);
    expect(matchesQuery(XAI, "   ")).toBe(true);
  });

  it("reads the label, the provider and the id", () => {
    expect(matchesQuery(SOL, "SOL")).toBe(true);
    expect(matchesQuery(SOL, "openai")).toBe(true);
    expect(matchesQuery(SOL, "openai-codex/gpt-5.6")).toBe(true);
    expect(matchesQuery(SOL, "grok")).toBe(false);
  });
});
