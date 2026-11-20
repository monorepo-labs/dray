import { describe, expect, it } from "vitest";
import type { BranchList } from "@/types/events";
import { worktreeBranchOptions } from "./worktreeBranches";

const list: BranchList = {
  current: "main",
  branches: ["main", "worktree-calm-owl", "feature/login"],
  remoteBranches: ["main", "release/2.0", "fix-login"],
  defaultBase: "origin/main",
  dirty: 0,
};

describe("worktreeBranchOptions", () => {
  it("pulls the default branch out to sit first", () => {
    expect(worktreeBranchOptions(list)).toEqual({
      defaultBranch: "main",
      local: ["worktree-calm-owl", "feature/login"],
      remote: ["release/2.0", "fix-login"],
    });
  });

  it("keeps names holding the query, those starting with it first", () => {
    expect(worktreeBranchOptions(list, "LOGIN")).toEqual({
      defaultBranch: null,
      local: ["feature/login"],
      remote: ["fix-login"],
    });
    expect(worktreeBranchOptions({ ...list, branches: ["my-fix", "fix-a"] }, "fix").local).toEqual(["fix-a", "my-fix"]);
  });

  it("has no default branch without a remote one", () => {
    const options = worktreeBranchOptions({ ...list, defaultBase: null, remoteBranches: [] });
    expect(options.defaultBranch).toBeNull();
    expect(options.local).toEqual(["main", "worktree-calm-owl", "feature/login"]);
  });
});
