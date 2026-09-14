import { describe, expect, it } from "vitest";

import { commandBrand } from "./pluginBrand";

describe("commandBrand", () => {
  it("tints a namespaced command from a plugin we hold a colour for", () => {
    expect(commandBrand("/greptile:review")).toBe("#28e99f");
    expect(commandBrand("/greptile:review focus on the auth changes")).toBe("#28e99f");
  });

  // The same vendor's skills are symlinked into ~/.claude/skills, so they carry
  // no namespace and are matched by name.
  it("tints the same vendor's bare-named skills", () => {
    expect(commandBrand("/greploop")).toBe("#28e99f");
    expect(commandBrand("/cli-review main")).toBe("#28e99f");
    expect(commandBrand("/check-pr 173")).toBe("#28e99f");
  });

  it("leaves every other message alone", () => {
    expect(commandBrand("/review")).toBeNull();
    expect(commandBrand("/railway:deploy")).toBeNull();
    expect(commandBrand("run /greptile:review for me")).toBeNull();
    expect(commandBrand("")).toBeNull();
  });
});
