import { describe, expect, it } from "vitest";

import { nextAutoUpdate } from "@/lib/agentUpdates";
import type { AgentUpdate, Harness } from "@/types/events";

const update = (harness: Harness, latest = "2.0.0"): AgentUpdate => ({
  harness,
  label: harness,
  current: "1.0.0",
  latest,
});

const ALL: Harness[] = ["claude_code", "codex", "pi", "fx", "grok"];
const idle = () => false;
const none = new Map<Harness, string>();

describe("nextAutoUpdate", () => {
  it("takes the first update behind", () => {
    expect(nextAutoUpdate([update("codex"), update("grok")], ALL, idle, none)?.harness).toBe("codex");
  });

  it("answers null with nothing behind", () => {
    expect(nextAutoUpdate([], ALL, idle, none)).toBeNull();
  });

  it("leaves an agent switched off alone", () => {
    expect(nextAutoUpdate([update("codex")], ["claude_code"], idle, none)).toBeNull();
  });

  // Every update ends in a check that hands a failure straight back, so a retry
  // here would run a failing updater in a loop.
  it("does not try the same version twice", () => {
    const tried = new Map<Harness, string>([["codex", "2.0.0"]]);
    expect(nextAutoUpdate([update("codex")], ALL, idle, tried)).toBeNull();
  });

  it("tries again when a newer version is out", () => {
    const tried = new Map<Harness, string>([["codex", "2.0.0"]]);
    expect(nextAutoUpdate([update("codex", "2.0.1")], ALL, idle, tried)?.latest).toBe("2.0.1");
  });

  it("holds pi and fx while their turn runs, and moves on to the next", () => {
    const running = (h: Harness) => h === "pi" || h === "fx";
    expect(nextAutoUpdate([update("pi"), update("fx")], ALL, running, none)).toBeNull();
    expect(nextAutoUpdate([update("pi"), update("grok")], ALL, running, none)?.harness).toBe("grok");
  });

  it("never holds an agent that installs beside its running binary", () => {
    expect(nextAutoUpdate([update("claude_code")], ALL, () => true, none)?.harness).toBe("claude_code");
  });
});
