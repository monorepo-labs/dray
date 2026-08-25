import { describe, expect, it } from "vitest";

import { isRoutineError } from "./tools";

// Every string here is a real `Bash` error taken out of `~/.dray/sessions`,
// including the "Exit code N" prefix a shell failure actually arrives with —
// the patterns have to match inside that, not against a bare message.
describe("isRoutineError", () => {
  it("passes over a worktree isolation refusal", () => {
    expect(
      isRoutineError(
        "This session is isolated in the worktree /Users/y/p/.claude/worktrees/ivory-gold-fjord, " +
          "but this command is too complex to verify that it stays inside the worktree. " +
          "Refusing to run it — a worktree-isolated session's git operations must target its own worktree.",
      ),
    ).toBe(true);
  });

  it("passes over a missing path, whatever spelled it", () => {
    expect(isRoutineError("Exit code 1\n(eval):cd:1: no such file or directory: apps/desktop")).toBe(
      true,
    );
    expect(
      isRoutineError("Exit code 1\nsed: src/components/ChatInput.tsx: No such file or directory"),
    ).toBe(true);
    expect(isRoutineError("Exit code 2\nugrep: warning: src/App.tsx: No such file or directory")).toBe(
      true,
    );
  });

  it("passes over a glob that matched nothing", () => {
    expect(isRoutineError("Exit code 1\n(eval):1: no matches found: *.tgz")).toBe(true);
  });

  it("passes over a binary that isn't there", () => {
    expect(isRoutineError("Exit code 127\n(eval):1: command not found: claude")).toBe(true);
  });

  it("passes over a command the harness blocked", () => {
    expect(isRoutineError("Blocked: sleep 60 followed by: gh pr view 7")).toBe(true);
  });

  it("still marks a real failure", () => {
    expect(isRoutineError("Exit code 1\ntar: Option --one-top-level=dlg is not supported")).toBe(
      false,
    );
    expect(
      isRoutineError("Exit code 1\nTraceback (most recent call last):\n  File \"<string>\", line 1"),
    ).toBe(false);
    expect(isRoutineError("Exit code 1\n(eval):1: === not found")).toBe(false);
  });

  it("treats a call with no text as worth marking", () => {
    expect(isRoutineError(undefined)).toBe(false);
    expect(isRoutineError("")).toBe(false);
  });
});
