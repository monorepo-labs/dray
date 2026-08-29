import { describe, expect, it } from "vitest";

import { forkBlocked } from "@/lib/fork";

describe("forkBlocked", () => {
  it("refuses only while a turn is in flight", () => {
    expect(forkBlocked("in_progress")).toBe(true);
    expect(forkBlocked("completed")).toBe(false);
    expect(forkBlocked("idle")).toBe(false);
  });

  // A session whose turn ended with a `local_bash` task still running reads
  // `completed` — that is the whole of what the backend sees too, so the item
  // is drawn enabled and the fork goes through. Guarding it here on anything
  // wider would put the menu back out of step with `SessionManager::fork`.
  it("offers a fork to a session still carrying a background task", () => {
    expect(forkBlocked("completed")).toBe(false);
  });

  // A row whose status has not landed yet — the map is keyed by session id and
  // holds only sessions this run has heard from. Nothing is running under an
  // id nothing has reported on, so the item is drawn rather than dimmed.
  it("reads an unknown status as not working", () => {
    expect(forkBlocked(undefined)).toBe(false);
  });
});
