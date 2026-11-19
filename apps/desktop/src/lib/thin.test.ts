import { describe, expect, it } from "vitest";
import { isCut } from "./thin";

describe("isCut", () => {
  it("reads the server's mark and nothing else", () => {
    expect(isCut({ command: "ls", _cut: true })).toBe(true);
    expect(isCut({ _cut: true })).toBe(true);
    expect(isCut({ command: "ls" })).toBe(false);
    expect(isCut({ _cut: "true" })).toBe(false);
    expect(isCut(null)).toBe(false);
    expect(isCut(undefined)).toBe(false);
    expect(isCut("_cut")).toBe(false);
  });
});
