import { describe, expect, it } from "vitest";

import { localNow } from "./platform";

describe("localNow", () => {
  // The server parses it as RFC 3339, so seconds and a signed offset are required.
  it("is this machine's wall clock with its offset, naming the same instant", () => {
    const at = new Date(2026, 10, 24, 9, 5, 0);
    const sent = localNow(at);
    expect(sent).toMatch(/^2026-11-24T09:05:00[+-]\d\d:\d\d$/);
    expect(Date.parse(sent)).toBe(at.getTime());
  });
});
