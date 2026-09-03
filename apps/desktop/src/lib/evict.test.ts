import { describe, expect, it } from "vitest";

import { IDLE_EVICT_MS, shouldEvict, type EvictInput } from "./evict";

const now = 1_000_000_000;
const base: EvictInput = {
  selected: false,
  status: "idle",
  asking: false,
  lastViewed: now - IDLE_EVICT_MS,
  now,
  force: false,
};

describe("shouldEvict", () => {
  it("evicts an idle session unviewed for the whole window", () => {
    expect(shouldEvict(base)).toBe(true);
  });

  it("keeps one viewed inside the window", () => {
    expect(shouldEvict({ ...base, lastViewed: now - IDLE_EVICT_MS + 1 })).toBe(false);
  });

  it("treats never-viewed as idle", () => {
    expect(shouldEvict({ ...base, lastViewed: undefined })).toBe(true);
  });

  it("never evicts the selected session, even forced", () => {
    expect(shouldEvict({ ...base, selected: true, force: true })).toBe(false);
  });

  it("never evicts a session mid-turn, even forced", () => {
    expect(shouldEvict({ ...base, status: "in_progress", force: true })).toBe(false);
  });

  it("never evicts a session holding a card, even forced", () => {
    expect(shouldEvict({ ...base, asking: true, force: true })).toBe(false);
  });

  it("force skips the idle clock", () => {
    expect(shouldEvict({ ...base, lastViewed: now, force: true })).toBe(true);
  });

  it("an unread completed session is evictable; its status lives elsewhere", () => {
    expect(shouldEvict({ ...base, status: "completed" })).toBe(true);
  });
});
