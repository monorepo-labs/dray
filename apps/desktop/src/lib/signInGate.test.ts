import { describe, expect, it } from "vitest";

import { gatesSignIn } from "./signInGate";

describe("gatesSignIn", () => {
  it("gates a release build", () => {
    expect(gatesSignIn({ DEV: false })).toBe(true);
  });

  it("gates a release build whatever the opt-in says", () => {
    expect(gatesSignIn({ DEV: false, VITE_DRAY_SIGN_IN: "0" })).toBe(true);
  });

  it("skips the gate in a dev build", () => {
    expect(gatesSignIn({ DEV: true })).toBe(false);
  });

  it("gates a dev build that opts in", () => {
    expect(gatesSignIn({ DEV: true, VITE_DRAY_SIGN_IN: "1" })).toBe(true);
  });
});
