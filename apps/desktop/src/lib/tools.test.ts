import { describe, expect, it } from "vitest";

import { groupLabel, isRoutineError, mcpCall, skillBrief, streamingLabel, subagentBrief, toolLabel, toolSummary } from "./tools";

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
      server: "Linear Server",
      label: "Save Issue",
      detail: "linear-server · save_issue",
    });
  });

  it("reads Codex's title, and drops the namespace the server already named", () => {
    expect(
      mcpCall("list_document_sessions", "codex_apps · codex_document_control.list_document_sessions"),
    ).toEqual({
      server: "Codex Apps",
      label: "List Document Sessions",
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
    expect(mcpCall("query", null)).toEqual({
      server: null,
      label: "Query",
      detail: "query",
    });
  });

  // grok wraps an MCP call in `use_tool` and hands the qualified name over with
  // no `mcp__` in front of it, so the bare form has to split too.
  it("reads a bare server__tool name", () => {
    expect(mcpCall("supermemory-ai__search_memory", null)).toEqual({
      server: "Supermemory Ai",
      label: "Search Memory",
      detail: "supermemory-ai · search_memory",
    });
  });
});

/// fx names a call's subject under keys no other harness uses — a skill's
/// opaque location, and an object called `request` holding the real argument —
/// so these rows read as their wire names with nothing beside them until the
/// two rules here fire.
describe("fx's own tools", () => {
  it("names a skill by the tail of its location", () => {
    expect(
      toolSummary("skill", "other", { location: "skill:68130a4a3e6c5614:0/find-skills" }),
    ).toBe("find-skills");
    expect(toolSummary("skill", "other", {})).toBe(null);
  });

  it("reads a nested request's task and query", () => {
    expect(
      toolSummary("subagent", "subagent_spawn", {
        request: { action: "run", task: "Run only `pwd`" },
      }),
    ).toBe("Run only `pwd`");
    expect(
      toolSummary("read_tool_result", "other", {
        request: { handle: "fx-command-replay-abc.bin", query: "37" },
      }),
    ).toBe("37");
    // A `request` that names neither falls through rather than answering with
    // the dispatch field beside them.
    expect(toolSummary("subagent", "subagent_spawn", { request: { action: "run" } })).toBe(
      null,
    );
  });

  it("names a search by its pattern, not the directory it scoped", () => {
    expect(
      toolSummary("grep_files", "search", {
        pattern: "needle",
        path: ".",
        include: "*.md",
      }),
    ).toBe("needle");
    // Same for a glob, which ACP classifies as a read.
    expect(toolSummary("glob_files", "file_read", { pattern: "*.txt", path: "src" })).toBe(
      "*.txt",
    );
    // And a tool whose subject really is the file is untouched.
    expect(toolSummary("read_file", "file_read", { path: "src/app.ts" })).toBe("src/app.ts");
  });

  it("conjugates its wire names", () => {
    expect(toolLabel("grep_files", true)).toBe("Searching");
    expect(toolLabel("web_fetch", false)).toBe("Fetched");
    expect(toolLabel("subagent", false)).toBe("Delegated");
    expect(toolLabel("read_tool_result", false)).toBe("Read output");
    // The row's verb carries the noun, so the count must not say it twice.
    expect(groupLabel("skill", 2, false)).toBe("Read 2 skills");
    expect(groupLabel("capability_search", 3, false)).toBe("Searched 3 capabilities");
  });
});

/// What a delegated run was asked to do, and what it was asked to do it with.
/// The row shows a truncated task, so the brief is what the expander draws —
/// and the model and effort are only there where the agent chose them for the
/// child, which is exactly when they are worth a slot on the row.
describe("subagentBrief", () => {
  it("reads the task, model and effort out of fx's request", () => {
    expect(
      subagentBrief({
        request: {
          action: "run",
          effort: "high",
          model: "gpt-5.6-luna",
          task: "Reply with exactly: hi",
        },
      }),
    ).toEqual({ task: "Reply with exactly: hi", model: "gpt-5.6-luna", effort: "high" });
  });

  it("leaves model and effort null where the child took the session's own", () => {
    expect(subagentBrief({ request: { action: "run", task: "Run `pwd`" } })).toEqual({
      task: "Run `pwd`",
      model: null,
      effort: null,
    });
  });

  // Every other harness briefs its child under a different key, and a spawn
  // with no task at all is not a brief.
  it("answers null for anything that nests no task", () => {
    expect(subagentBrief({ prompt: "Review the diff" })).toBeNull();
    expect(subagentBrief({ request: { action: "run", task: "   " } })).toBeNull();
    expect(subagentBrief({ request: "run" })).toBeNull();
    expect(subagentBrief(null)).toBeNull();
  });
});
