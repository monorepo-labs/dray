import { describe, expect, it } from "vitest";

import { agentPrompt, needLine } from "@/lib/tailscale";

describe("agentPrompt", () => {
  it("asks for the operator only off a Mac or PC", () => {
    expect(agentPrompt("linux")).toContain("--operator=$USER");
    expect(agentPrompt(null)).toContain("--operator=$USER");
    expect(agentPrompt("mac")).not.toContain("--operator");
    expect(agentPrompt("windows")).not.toContain("--operator");
  });

  it("leaves serving to Dray", () => {
    expect(agentPrompt("mac")).toContain("Don't run `tailscale serve` yourself");
  });
});

describe("needLine", () => {
  it("names what an existing handler serves", () => {
    expect(needLine({ kind: "taken", target: "http://127.0.0.1:3000" }, "Mac")).toBe(
      "Tailscale already serves http://127.0.0.1:3000 here.",
    );
    expect(needLine({ kind: "install", fix: false }, "Mac")).toBe("Tailscale isn't installed on this Mac.");
  });
});
