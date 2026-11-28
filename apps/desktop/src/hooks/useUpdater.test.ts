import { describe, expect, it } from "vitest";

import { dueOnFocus } from "./useUpdater";

const MIN = 60 * 1000;

describe("dueOnFocus", () => {
  it("checks when nothing has checked yet", () => {
    expect(dueOnFocus(null, 0)).toBe(true);
  });

  it("waits out the first 15 minutes after a check", () => {
    expect(dueOnFocus(0, 1 * MIN)).toBe(false);
    expect(dueOnFocus(0, 15 * MIN)).toBe(false);
  });

  it("checks once more than 15 minutes have passed", () => {
    expect(dueOnFocus(0, 15 * MIN + 1)).toBe(true);
  });
});
