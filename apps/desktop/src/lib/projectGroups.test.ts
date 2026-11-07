import { describe, expect, it } from "vitest";

import { groupProjects, inheritSpaces, keyOfPath, lastUsedCheckout, soleServer } from "@/lib/projectGroups";
import { qualify } from "@/lib/transport";
import type { Project } from "@/types/events";

const checkout = (path: string, over: Partial<Project> = {}): Project => ({
  path,
  name: path.split("/").pop()!,
  space: null,
  lastSelected: "2026-08-01T00:00:00.000Z",
  ...over,
});
const REMOTE = "github.com/a/dray";
const here = checkout("/code/dray", { remote: REMOTE });
const there = checkout(qualify("/srv/dray", "box"), { remote: REMOTE });

describe("groupProjects", () => {
  it("merges one remote across machines, in the place of its first checkout", () => {
    const other = checkout("/code/web", { remote: "github.com/a/web" });
    const groups = groupProjects([here, other, there]);
    expect(groups.map((g) => g.key)).toEqual([REMOTE, "github.com/a/web"]);
    expect(groups[0].checkouts).toEqual([here, there]);
  });

  it("keeps a repo with no remote, or from an older server, per path", () => {
    const a = checkout("/code/a");
    const b = checkout(qualify("/code/a", "box"));
    expect(groupProjects([a, b]).map((g) => g.key)).toEqual([a.path, b.path]);
  });

  it("merges two clones on one machine", () => {
    const again = checkout("/exp/dray", { remote: REMOTE });
    expect(groupProjects([here, again])).toHaveLength(1);
  });
});

describe("keyOfPath", () => {
  it("reads a path nobody attached as its own project", () => {
    expect(keyOfPath([here, there], there.path)).toBe(REMOTE);
    expect(keyOfPath([here, there], "/gone")).toBe("/gone");
  });
});

describe("lastUsedCheckout", () => {
  const newer = { ...there, lastSelected: "2026-09-01T00:00:00.000Z" };

  it("takes the newest pick", () => {
    expect(lastUsedCheckout([here, newer], () => true)).toBe(newer);
  });

  it("passes over a machine that dropped", () => {
    expect(lastUsedCheckout([here, newer], (s) => s === "local")).toBe(here);
  });

  it("still answers with nothing reachable", () => {
    expect(lastUsedCheckout([here, newer], () => false)).toBe(newer);
  });
});

describe("soleServer", () => {
  it("names one machine and refuses several", () => {
    expect(soleServer([there])).toBe("box");
    expect(soleServer([here, there])).toBeNull();
  });
});

describe("inheritSpaces", () => {
  it("gives a later copy its sibling's space and leaves its own alone", () => {
    const filed = { ...here, space: "Work" };
    const own = checkout("/exp/dray", { remote: REMOTE, space: "Play" });
    const [, second, third] = inheritSpaces([filed, there, own]);
    expect(second.space).toBe("Work");
    expect(third.space).toBe("Play");
  });

  it("leaves a project nobody filed unfiled", () => {
    expect(inheritSpaces([here])[0].space).toBeNull();
  });
});
