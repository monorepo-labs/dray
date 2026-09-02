import { describe, expect, it } from "vitest";

import {
  byProvider,
  matchesQuery,
  shortlist,
  toggleStar,
  topLevel,
  underMore,
  usesShortlist,
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
    ...over,
  };
}

const XAI = model("xai/grok-4.6");
const SPARK = model("openai-codex/gpt-5.3-codex-spark");
const SOL = model("openai-codex/gpt-5.6-sol");

describe("usesShortlist", () => {
  /// pi's list is discovered, so it has no bound. The other two ship a handful
  /// of models Dray names itself, where a shortlist would be one more thing to
  /// set up before the picker works at all.
  it("is pi's alone", () => {
    expect(usesShortlist("pi")).toBe(true);
    expect(usesShortlist("claude_code")).toBe(false);
    expect(usesShortlist("codex")).toBe(false);
  });
});

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

describe("topLevel", () => {
  const FABLE = model("fable");
  const OPUS = model("opus");
  const HAIKU = model("haiku", { secondary: true });
  const CLAUDE = [FABLE, OPUS, HAIKU];

  /// Shift+Tab cycles this list, so a row it holds that the menu doesn't draw
  /// is a press landing somewhere the reader was never offered.
  it("holds back what the picker folds under More", () => {
    const drawn = topLevel(CLAUDE, [], "claude_code", FABLE.id);

    expect(drawn.map((m) => m.id)).toEqual([FABLE.id, OPUS.id]);
    expect(underMore(CLAUDE, "claude_code").map((m) => m.id)).toEqual([HAIKU.id]);
  });

  /// The bug this pair exists to stop: pi's menu drew the reader's shortlist
  /// while the chord walked every model every logged-in provider served, so a
  /// press switched to a model that was nowhere on screen.
  it("bounds pi by the reader's stars, not by secondary", () => {
    const drawn = topLevel([XAI, SPARK, SOL], [SOL.id], "pi", XAI.id);

    expect(drawn.map((m) => m.id)).toEqual([XAI.id, SOL.id]);
    expect(drawn).not.toContain(SPARK);
  });

  /// pi's overflow is the library dialog, so a submenu there would be a second
  /// answer to a question the shortlist already answers.
  it("folds nothing under More for a shortlisted harness", () => {
    expect(underMore([XAI, SPARK, SOL], "pi")).toEqual([]);
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
