import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_FOR,
  HARNESS_ORDER,
  isUnsetModel,
  nextHarness,
  rememberedModel,
  UNSET_MODEL,
  usableEffort,
  usableFxModel,
  fxListFor,
  usableModel,
} from "./model";
import type { Effort, Model } from "@/types/events";

const model = (id: string, provider?: string): Model =>
  ({ id, label: id, efforts: [], defaultEffort: null, provider }) as unknown as Model;

const CODEX = [model("gpt6_astra"), model("gpt55")];
const CLAUDE = [model("fable"), model("opus"), model("haiku")];

describe("usableModel", () => {
  it("keeps a pick the harness can run", () => {
    expect(usableModel(CODEX, "gpt55" as never, "codex")).toBe("gpt55");
  });

  /// The whole point: a model stored under the other harness reaches every
  /// seeding path, not only the one that switched harness.
  it("replaces a pick belonging to the other harness", () => {
    expect(usableModel(CODEX, "haiku" as never, "codex")).toBe("gpt6_astra");
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

  /// Under a harness Dray names a default for, the sentinel is a pick nobody
  /// made and gives way to that default.
  it("gives way once a real list arrives", () => {
    expect(usableModel(CLAUDE, UNSET_MODEL, "claude_code")).toBe("opus");
  });

  /// Under pi it is a real answer and stands. The spawn omits `--model` there,
  /// so pi runs whatever its own settings name — where repairing onto the head
  /// of the list would override a choice the reader already made, with nothing
  /// on screen saying it happened.
  it("stands where the harness names no default", () => {
    expect(usableModel(CODEX, UNSET_MODEL, "pi")).toBe(UNSET_MODEL);
  });

  /// An empty list means the models have not arrived yet, so nothing is known
  /// well enough to repair the pick. That is pi's resting state until the probe
  /// that discovers its list lands.
  it("stands while the list is empty", () => {
    expect(usableModel([], UNSET_MODEL, "pi")).toBe(UNSET_MODEL);
  });

  /// A pick pi cannot run falls to "let pi decide", never to the head of the
  /// list. The head is a model the reader never starred, and it reached the
  /// spawn as a `--model` nobody asked for — with nothing on screen saying the
  /// remembered pick had been replaced.
  it("is where a pick pi cannot run falls, not the head of the list", () => {
    expect(usableModel(CLAUDE, "gpt55" as never, "pi")).toBe(UNSET_MODEL);
  });
});

describe("usableFxModel", () => {
  const GATEWAY = [model("anthropic/fable", "gateway"), model("openai/gpt6", "gateway")];

  it("keeps a pick the provider still serves", () => {
    expect(usableFxModel(GATEWAY, "openai/gpt6" as never, {})).toBe("openai/gpt6");
  });

  /// The whole point: a pick from another provider restores this provider's
  /// last model rather than dropping to "let fx decide".
  it("restores this provider's last model over an out-of-provider pick", () => {
    const picks = { gateway: "anthropic/fable" };
    expect(usableFxModel(GATEWAY, "gpt56_sol" as never, picks)).toBe("anthropic/fable");
  });

  /// A remembered model the provider no longer serves is not forced back on.
  it("falls to the sentinel when the remembered model is gone", () => {
    const picks = { gateway: "xai/grok" };
    expect(usableFxModel(GATEWAY, "gpt56_sol" as never, picks)).toBe(UNSET_MODEL);
  });

  it("falls to the sentinel when the provider was never picked in", () => {
    expect(usableFxModel(GATEWAY, "gpt56_sol" as never, {})).toBe(UNSET_MODEL);
  });

  /// An empty list has not arrived yet, so the pick stands.
  it("leaves the pick alone until the list lands", () => {
    expect(usableFxModel([], "gpt56_sol" as never, { gateway: "x" })).toBe("gpt56_sol");
  });
});

describe("fxListFor", () => {
  const GATEWAY = [model("anthropic/fable", "gateway")];
  const CODEX = [model("gpt-5.6-sol", "codex")];
  const cache = { gateway: GATEWAY, codex: CODEX };

  /// The bug: fx's provider moved under session A, and session B's picker drew
  /// A's list. B's pick names its own provider, so its list follows the pick.
  it("draws the picked model's provider over the active one", () => {
    expect(fxListFor(cache, "anthropic/fable" as never, CODEX)).toBe(GATEWAY);
  });

  it("draws the active list where the pick is on it", () => {
    expect(fxListFor(cache, "gpt-5.6-sol" as never, CODEX)).toBe(CODEX);
  });

  it("draws the active list for a pick no provider names, and for none", () => {
    expect(fxListFor(cache, "nobody/knows" as never, CODEX)).toBe(CODEX);
    expect(fxListFor(cache, UNSET_MODEL, CODEX)).toBe(CODEX);
  });
});

describe("nextHarness", () => {
  /// Toggling between two was written when there were two, and silently never
  /// reached the third. The chord steps the picker's own row instead.
  it("steps through every harness in the picker's order and wraps", () => {
    expect(HARNESS_ORDER).toEqual(["claude_code", "codex", "pi", "fx"]);
    expect(nextHarness("claude_code")).toBe("codex");
    expect(nextHarness("codex")).toBe("pi");
    expect(nextHarness("pi")).toBe("fx");
    expect(nextHarness("fx")).toBe("claude_code");
  });

  it("parks an unknown harness on the first", () => {
    expect(nextHarness("other" as never)).toBe("claude_code");
  });
});

describe("usableEffort", () => {
  const withEfforts = (efforts: Effort[], defaultEffort: Effort | null = null): Model =>
    ({ id: "m", label: "m", efforts, defaultEffort }) as unknown as Model;

  const LUNA: Effort[] = ["low", "medium", "high", "xhigh", "max"];

  it("keeps a remembered level the model offers", () => {
    expect(usableEffort(withEfforts(LUNA), "high", "high")).toBe("high");
  });

  /// DRA-221: fx's ladder is per model and learned from a live session, so a
  /// level picked off the provider's guess can stop being offered mid-session.
  /// Left standing, the trigger names a rung the menu no longer has and the
  /// next send asks fx for it again.
  it("drops a remembered level the model has stopped offering", () => {
    expect(usableEffort(withEfforts(LUNA), "ultra", "high")).toBe("high");
  });

  /// The fall-back is the top of the ladder, not the app default: a pick that
  /// has fallen off the list is one above the model's top rung, so landing on
  /// medium would be a downgrade nobody asked for.
  it("falls to the highest rung when nothing else is offered", () => {
    expect(usableEffort(withEfforts(["low", "medium"]), "ultra", "high")).toBe("medium");
  });

  it("prefers the model's own default over the app's", () => {
    expect(usableEffort(withEfforts(LUNA, "low"), "ultra", "high")).toBe("low");
  });

  /// An empty ladder is a real answer — fx reports no `effort` option at all
  /// for a model that does no reasoning — and `null` is what hides the control.
  it("answers null for a model that takes no effort", () => {
    expect(usableEffort(withEfforts([]), "high", "high")).toBeNull();
  });
});
