import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BotPreview } from "@/types/events";

// What each task's server answers: a preview, an error, or never.
const answers = new Map<string, BotPreview | "error" | "silent">();
const asked: string[] = [];
vi.mock("@/lib/bots", async (real) => ({
  ...(await real<typeof import("@/lib/bots")>()),
  readPreviews: async (ids: string[]) => {
    const id = ids[0];
    asked.push(id);
    const answer = answers.get(id);
    if (answer === "silent") return new Promise(() => {});
    // `readPreviews` drops a server that errors rather than throwing.
    return answer === "error" || !answer ? {} : { [id]: answer };
  },
}));

const { READ_TIMEOUT_MS, readStallLine } = await import("./useStallLine");

describe("readStallLine", () => {
  beforeEach(() => {
    answers.clear();
    asked.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("reads the last paragraph of the task's last message", async () => {
    answers.set("a", { text: "Built it.\n\nKeep the **rename** button, or drop it?", replies: 1 });
    await expect(readStallLine("a:1", "a")).resolves.toBe("Keep the rename button, or drop it?");
  });

  it("answers null for a task that wrote nothing", async () => {
    answers.set("b", { text: null, replies: 0 });
    await expect(readStallLine("b:1", "b")).resolves.toBeNull();
  });

  it("gives up on a server that never answers", async () => {
    answers.set("c", "silent");
    const line = readStallLine("c:1", "c");
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await expect(line).resolves.toBeUndefined();
  });

  it("reads again after a failure, and not after an answer", async () => {
    answers.set("d", "error");
    await expect(readStallLine("d:1", "d")).resolves.toBeUndefined();
    answers.set("d", { text: "Which port?", replies: 1 });
    await expect(readStallLine("d:1", "d")).resolves.toBe("Which port?");
    expect(asked).toEqual(["d", "d"]);
  });

  it("shares one read between rows asking at once", async () => {
    answers.set("e", { text: "Ready.", replies: 1 });
    await Promise.all([readStallLine("e:1", "e"), readStallLine("e:1", "e")]);
    expect(asked).toEqual(["e"]);
  });
});
