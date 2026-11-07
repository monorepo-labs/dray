import { describe, expect, it } from "vitest";

import { nextAutoUpdate, turnRunningOn } from "@/lib/agentUpdates";
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

describe("turnRunningOn", () => {
  const rows = [
    { sessionId: "a", harness: "pi" as const },
    { sessionId: "b", harness: "codex" as const },
  ];

  const local = () => true;

  it("reads the running session's own agent", () => {
    expect(turnRunningOn("pi", { a: "in_progress" }, rows, local)).toBe(true);
    expect(turnRunningOn("fx", { a: "in_progress" }, rows, local)).toBe(false);
  });

  it("ignores sessions that are not running", () => {
    expect(turnRunningOn("pi", { a: "idle", b: "completed" }, rows, local)).toBe(false);
  });

  // The archived view takes running sessions out of the list, and an update
  // landing then overwrites files their child is reading.
  it("counts a running session with no row, whichever agent is asked about", () => {
    expect(turnRunningOn("pi", { gone: "in_progress" }, rows, local)).toBe(true);
    expect(turnRunningOn("fx", { gone: "in_progress" }, [], local)).toBe(true);
  });

  it("ignores a session on another machine, row or no row", () => {
    const remote = () => false;
    expect(turnRunningOn("pi", { a: "in_progress" }, rows, remote)).toBe(false);
    expect(turnRunningOn("pi", { gone: "in_progress" }, rows, remote)).toBe(false);
  });
});

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
