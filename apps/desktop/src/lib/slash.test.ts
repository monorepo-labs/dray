import { describe, expect, it } from "vitest";

import {
  applyCommand,
  commandSource,
  filterCommands,
  groupCommands,
  parseSlashCommand,
  slashQuery,
} from "./slash";
import type { SlashCommand } from "@/types/events";

function command(
  name: string,
  description = "",
  aliases: string[] = [],
): SlashCommand {
  return { name, description, argumentHint: "", aliases };
}

describe("slashQuery", () => {
  it("opens on a leading slash and tracks what follows it", () => {
    expect(slashQuery("/", 1)).toBe("");
    expect(slashQuery("/rev", 4)).toBe("rev");
  });

  /// A slash inside prose is a path or a date, not a command. Firing there
  /// would put a picker over most sentences that mention a file.
  it("stays shut for a slash that isn't leading", () => {
    expect(slashQuery("look at src/lib", 15)).toBeNull();
    expect(slashQuery("on 12/08", 8)).toBeNull();
  });

  /// The command is settled once a space is typed, so the picker gets out of
  /// the way of the arguments.
  it("closes once the caret moves into the arguments", () => {
    expect(slashQuery("/review the diff", 16)).toBeNull();
    expect(slashQuery("/review ", 8)).toBeNull();
  });

  /// Backspacing into the name to fix it has to reopen the picker, which is
  /// what makes this caret-based rather than "the text has no space in it".
  it("reopens when the caret goes back into the name", () => {
    expect(slashQuery("/review the diff", 7)).toBe("review");
    expect(slashQuery("/review the diff", 4)).toBe("review");
  });

  it("ignores a caret sitting on the slash itself", () => {
    expect(slashQuery("/rev", 0)).toBeNull();
  });
});

describe("filterCommands", () => {
  const commands = [
    command("compact", "Free up context"),
    command("clear", "Start a new session", ["reset", "new"]),
    command("railway:deploy", "Deploy to Railway"),
    command("usage", "Show plan limits"),
    command("cost", "Token usage for this session"),
    command("model", "Set the AI model for Claude Code"),
  ];

  /// Stable sort plus an all-equal score means the CLI's own ordering survives,
  /// which is what groups user commands ahead of built-ins.
  it("keeps the given order when nothing is typed", () => {
    expect(filterCommands(commands, "").map((c) => c.name)).toEqual([
      "compact",
      "clear",
      "railway:deploy",
      "usage",
      "cost",
      "model",
    ]);
  });

  /// `/cost` describes itself as token usage, so a bare "usage" matches both —
  /// the one *named* it has to win, or typing a command's exact name can still
  /// leave something else selected.
  it("puts a name prefix ahead of a description mention", () => {
    expect(filterCommands(commands, "usage").map((c) => c.name)).toEqual(["usage", "cost"]);
  });

  it("finds a command by its alias", () => {
    expect(filterCommands(commands, "reset").map((c) => c.name)).toEqual(["clear"]);
  });

  /// A namespaced command is most often remembered by its bare half — nobody
  /// types the plugin name first.
  it("finds a namespaced command by its bare half", () => {
    expect(filterCommands(commands, "deploy").map((c) => c.name)).toEqual(["railway:deploy"]);
  });

  it("drops what matches nothing", () => {
    expect(filterCommands(commands, "zzz")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(filterCommands(commands, "COMPACT").map((c) => c.name)).toEqual(["compact"]);
  });
});

describe("commandSource", () => {
  /// Verbatim shapes from a real `initialize` payload — the classification is
  /// only as good as these strings, so they are copied rather than invented.
  it("reads the two signals the payload actually carries", () => {
    expect(commandSource(command("railway:deploy", "Deploy to Railway"))).toBe("plugin");
    expect(commandSource(command("supalytics", "Query web analytics. (user)"))).toBe("user");
    expect(commandSource(command("review", "Pre-landing PR review. (gstack) (user)"))).toBe("user");
    expect(commandSource(command("compact", "Free up context by summarizing"))).toBe("harness");
  });

  /// A bundled skill is indistinguishable from a built-in and is meant to be:
  /// neither was installed by anyone, so both read as "came with Claude Code".
  it("files a bundled skill with the built-ins", () => {
    expect(commandSource(command("dataviz", "Use this skill whenever..."))).toBe("harness");
  });

  /// Descriptions end in parentheses for ordinary reasons, so only the scope
  /// words count — otherwise `/clear` would file itself as a user command.
  it("is not fooled by a description that merely ends in parentheses", () => {
    expect(commandSource(command("clear", "Start a new session (resumable with /resume)"))).toBe(
      "harness",
    );
    expect(commandSource(command("fast", "Toggle fast mode (Opus 5)"))).toBe("harness");
  });
});

describe("groupCommands", () => {
  const commands = [
    command("compact", "Free up context"),
    command("model", "Set the AI model"),
    command("railway:deploy", "Deploy to Railway"),
    command("supalytics", "Query analytics. (user)"),
  ];

  it("orders recents, then harness, then everything installed", () => {
    expect(groupCommands(commands, ["supalytics"])).toEqual([
      { label: "Recently used", items: [commands[3]] },
      { label: null, items: [commands[0], commands[1]] },
      { label: null, items: [commands[2]] },
    ]);
  });

  /// A promoted command leaves its own group. Showing it twice would spend two
  /// of the seven visible rows saying the same thing.
  it("promotes rather than duplicates", () => {
    const names = groupCommands(commands, ["compact"]).flatMap((g) =>
      g.items.map((c) => c.name),
    );

    expect(names).toEqual(["compact", "model", "railway:deploy", "supalytics"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("ranks recents by the stored order, newest first", () => {
    const recent = groupCommands(commands, ["model", "compact"])[0];
    expect(recent.items.map((c) => c.name)).toEqual(["model", "compact"]);
  });

  /// The store outlives the commands it names — a skill gets uninstalled, a
  /// project-scoped command is left behind in another repo.
  it("drops remembered names that no longer exist", () => {
    const groups = groupCommands(commands, ["long-gone", "compact"]);
    expect(groups[0].items.map((c) => c.name)).toEqual(["compact"]);
  });

  it("caps recents so they cannot fill the window", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map((n) => command(n));
    const groups = groupCommands(many, ["a", "b", "c", "d", "e", "f"]);
    expect(groups[0].items).toHaveLength(4);
  });

  it("drops empty groups rather than drawing an empty heading", () => {
    expect(groupCommands([command("compact", "Free up context")], [])).toEqual([
      { label: null, items: [command("compact", "Free up context")] },
    ]);
  });
});

describe("applyCommand", () => {
  it("completes a half-typed name and leaves the caret past a space", () => {
    expect(applyCommand("/comp", "compact")).toEqual({ text: "/compact ", caret: 9 });
  });

  /// Picking a different command from inside a line that already has arguments
  /// must not eat them.
  it("keeps arguments already typed", () => {
    expect(applyCommand("/rev the diff", "review")).toEqual({
      text: "/review the diff",
      caret: 8,
    });
  });

  it("completes a bare slash", () => {
    expect(applyCommand("/", "usage")).toEqual({ text: "/usage ", caret: 7 });
  });
});

describe("parseSlashCommand", () => {
  it("splits a command from its arguments", () => {
    expect(parseSlashCommand("/compact keep the diff notes")).toEqual({
      name: "compact",
      args: "keep the diff notes",
    });
  });

  it("reads a bare command", () => {
    expect(parseSlashCommand("/usage")).toEqual({ name: "usage", args: "" });
    expect(parseSlashCommand("/usage  ")).toEqual({ name: "usage", args: "" });
  });

  it("keeps namespaced names whole", () => {
    expect(parseSlashCommand("/railway:deploy now")).toEqual({
      name: "railway:deploy",
      args: "now",
    });
  });

  /// Multi-line arguments are ordinary — a command taking a pasted block still
  /// leads with its name.
  it("reads arguments spanning lines", () => {
    expect(parseSlashCommand("/spec build\na login page")).toEqual({
      name: "spec",
      args: "build\na login page",
    });
  });

  it("leaves prose alone", () => {
    expect(parseSlashCommand("check src/lib/slash.ts")).toBeNull();
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("// a comment")).toBeNull();
    expect(parseSlashCommand("/ spaced")).toBeNull();
  });
});
