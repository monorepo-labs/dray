import { describe, expect, it } from "vitest";

import { groupLabel, isRoutineError, mcpCall, skillBrief, streamingLabel, toolLabel, toolSummary } from "./tools";

// Every input here is a real `Skill` call taken out of `~/.dray/sessions`. The
// harness classifies the tool as `other` and leaves `title` null, so the name
// and the brief are the whole of what the row has to work with.
describe("a Skill call", () => {
  it("names the skill, not the tool", () => {
    expect(toolSummary("Skill", "other", { skill: "caveman-commit" })).toBe("caveman-commit");
    expect(
      toolSummary("Skill", "other", { args: "screenshot localhost:1420", skill: "agent-browser" }),
    ).toBe("agent-browser");
  });

  // "Reading", not "Launching". A skill is a document the agent goes and reads,
  // and the row sits beside the skill's own name — so this reads "Read Skill
  // caveman-commit", where "Launched" suggested something was started and left
  // running. The group verb drops the noun the row's own verb carries, or a
  // count would say it twice: "Read Skill 2 skills".
  it("reads as a read in both tenses, and names the skill only on a row", () => {
    expect(toolLabel("Skill", true)).toBe("Reading Skill");
    expect(toolLabel("Skill", false)).toBe("Read Skill");
    expect(groupLabel("Skill", 2, false)).toBe("Read 2 skills");
    expect(streamingLabel("Skill")).toBe("Reading a skill");
  });

  it("takes the brief only where one was written", () => {
    expect(skillBrief({ args: "screenshot localhost:1420", skill: "agent-browser" })).toBe(
      "screenshot localhost:1420",
    );
    expect(skillBrief({ skill: "caveman-commit" })).toBeNull();
    expect(skillBrief({ args: "   ", skill: "caveman-commit" })).toBeNull();
  });
});


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

describe("mcpCall", () => {
  // Both harnesses spell the same call for a machine, and drawn raw the row
  // said the wire id twice — once as its label, again as its summary.
  it("reads Claude's mcp__server__tool", () => {
    expect(mcpCall("mcp__linear-server__save_issue", null)).toEqual({
      label: "Save issue",
      detail: "linear-server · save_issue",
    });
  });

  it("reads Codex's title, and drops the namespace the server already named", () => {
    expect(
      mcpCall("list_document_sessions", "codex_apps · codex_document_control.list_document_sessions"),
    ).toEqual({
      label: "List document sessions",
      detail: "codex_apps · codex_document_control.list_document_sessions",
    });
  });

  // A tool half carrying `__` of its own must not be cut short.
  it("keeps a tool name containing the separator", () => {
    expect(mcpCall("mcp__srv__a__b", null).detail).toBe("srv · a__b");
  });

  // Nothing to split on is an ordinary state, not a malformed one: the row
  // still needs something to draw.
  it("falls back to the bare name", () => {
    expect(mcpCall("query", null)).toEqual({ label: "Query", detail: "query" });
  });
});
