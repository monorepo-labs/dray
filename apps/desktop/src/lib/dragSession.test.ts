import { describe, expect, it } from "vitest";

import { regionAt } from "@/lib/dragSession";

describe("regionAt", () => {
  it("maps the middle to centre and each edge band to its side", () => {
    expect(regionAt(50, 50, 100, 100)).toBe("center");
    expect(regionAt(10, 50, 100, 100)).toBe("left");
    expect(regionAt(90, 50, 100, 100)).toBe("right");
    expect(regionAt(50, 10, 100, 100)).toBe("top");
    expect(regionAt(50, 90, 100, 100)).toBe("bottom");
  });

  it("gives a corner to the nearer edge", () => {
    expect(regionAt(5, 20, 100, 100)).toBe("left");
    expect(regionAt(20, 95, 100, 100)).toBe("bottom");
  });
});
