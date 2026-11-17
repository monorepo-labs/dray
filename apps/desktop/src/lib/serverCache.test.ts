import { describe, expect, it } from "vitest";

import { keptRepo, keptRow, serverShown, unfinishedWarning, unreachable, withKept } from "@/lib/serverCache";
import { qualify } from "@/lib/transport";
import type { PrMark, ServerInfo, SessionIndexItem } from "@/types/events";

const server = (id: string, over: Partial<ServerInfo> = {}): ServerInfo =>
  ({ id, name: id, on: true, status: "connected", ...over }) as ServerInfo;
const row = (path: string) => ({ path });
const pathOf = (r: { path: string }) => r.path;

const here = row("/code/dray");
const boxRow = row(qualify("/srv/dray", "box"));
const kept = row(qualify("/srv/web", "box"));

describe("serverShown", () => {
  it("shows This Mac, and a remote while listed and on", () => {
    expect(serverShown("local", [])).toBe(true);
    expect(serverShown("box", [server("box", { status: "disconnected" })])).toBe(true);
    expect(serverShown("box", [server("box", { on: false })])).toBe(false);
    expect(serverShown("box", [])).toBe(false);
  });
});

describe("unreachable", () => {
  it("names servers that are on and not connected", () => {
    const list = [
      server("up"),
      server("down", { status: "disconnected" }),
      server("trying", { status: "connecting" }),
      server("off", { on: false, status: "disconnected" }),
    ];
    expect(unreachable(list)).toEqual(["down", "trying"]);
  });
});

describe("withKept", () => {
  it("hides a server turned off, and one removed", () => {
    const prev = [here, boxRow];
    expect(withKept(prev, [server("box", { on: false })], [], () => undefined, pathOf)).toEqual([here]);
    expect(withKept(prev, [], [], () => undefined, pathOf)).toEqual([here]);
  });

  it("draws an unreachable server's kept rows where it draws none", () => {
    const list = [server("box", { status: "disconnected" })];
    expect(withKept([here], list, ["box"], () => [kept], pathOf)).toEqual([here, kept]);
  });

  it("keeps rows already on screen over the kept ones, which are older", () => {
    const list = [server("box", { status: "disconnected" })];
    expect(withKept([here, boxRow], list, ["box"], () => [kept], pathOf)).toEqual([here, boxRow]);
  });

  it("answers the same array when nothing moves, so React skips the render", () => {
    const prev = [here, boxRow];
    expect(withKept(prev, [server("box")], [], () => undefined, pathOf)).toBe(prev);
  });
});

describe("keptRow", () => {
  const task = { projectPath: "/srv/dray", branch: null, worktreeName: "fix-login", status: "idle" } as SessionIndexItem;
  const marks = (state: PrMark["state"] | null) => (repo: string, branch: string | null) =>
    repo === "/srv/dray" && branch === "worktree-fix-login" ? (state && ({ state } as PrMark)) : undefined;

  it("marks a row whose PR is open, and only that", () => {
    expect(keptRow(task, marks("OPEN"))).toEqual({ ...task, prOpen: true });
    expect(keptRow(task, marks("MERGED"))).toBe(task);
    expect(keptRow(task, () => undefined)).toBe(task);
  });

  it("clears a kept mark once a newer read says otherwise, and only then", () => {
    const kept = { ...task, prOpen: true as const };
    expect(keptRow(kept, marks("MERGED"))).toEqual(task);
    expect(keptRow(kept, marks(null))).toEqual(task);
    expect(keptRow(kept, () => undefined)).toBe(kept);
  });

  it("keeps the PR's repo, so it can be read from here while the machine is down", () => {
    const url = "https://github.com/acme/dray/pull/4";
    const withUrl = (repo: string, branch: string | null) =>
      repo === "/srv/dray" && branch === "worktree-fix-login" ? ({ state: "OPEN", url } as PrMark) : undefined;
    const kept = keptRow(task, withUrl);
    expect(kept).toEqual({ ...task, prOpen: true, prRepo: "acme/dray" });
    expect(keptRepo(kept)).toBe("acme/dray");
    // The repo outlives the PR: a merged or vanished one still names it.
    expect(keptRow(kept, marks(null))).toEqual({ ...task, prRepo: "acme/dray" });
  });

  it("keeps the last kept fields on a fresh row whose PR is not read yet", () => {
    const before = { ...task, prOpen: true as const, prRepo: "acme/dray" };
    expect(keptRow(task, () => undefined, undefined, before)).toEqual(before);
    // A read wins over what was kept, but the repo stays.
    expect(keptRow(task, marks("MERGED"), undefined, before)).toEqual({ ...task, prRepo: "acme/dray" });
  });

  it("carries the live status over the index row's", () => {
    expect(keptRow(task, () => undefined, "in_progress")).toEqual({ ...task, status: "in_progress" });
    expect(keptRow(task, () => undefined, "idle")).toBe(task);
  });
});

describe("unfinishedWarning", () => {
  it("says nothing with nothing unfinished", () => {
    expect(unfinishedWarning(undefined)).toBeNull();
    expect(unfinishedWarning([])).toBeNull();
  });

  it("counts and names each task", () => {
    expect(unfinishedWarning(["Fix login"])).toMatch(/^1 task here .*“Fix login”\./);
    expect(unfinishedWarning(["A", "B"])).toMatch(/^2 tasks here .*“A”, “B”\./);
  });
});
