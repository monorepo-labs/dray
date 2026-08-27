import { describe, expect, it } from "vitest";

import { devBadgeLabel } from "@/components/Sidebar";

describe("devBadgeLabel", () => {
  it("names the branch", () => {
    expect(devBadgeLabel("dra-56-pinned-group")).toBe("Dev · dra-56-pinned-group");
  });

  it("stays bare on main", () => {
    expect(devBadgeLabel("main")).toBe("Dev");
  });

  it("stays bare with no branch to name", () => {
    expect(devBadgeLabel(null)).toBe("Dev");
    expect(devBadgeLabel("")).toBe("Dev");
  });

  it("drops a worktree branch's prefix", () => {
    expect(devBadgeLabel("worktree-gentle-denim-fjord")).toBe(
      "Dev · gentle-denim-fjord",
    );
  });

  // The `main` test reads the branch, not the name left after stripping, so a
  // worktree called `main` still says which tree it is.
  it("keeps a worktree named main", () => {
    expect(devBadgeLabel("worktree-main")).toBe("Dev · main");
  });
});
