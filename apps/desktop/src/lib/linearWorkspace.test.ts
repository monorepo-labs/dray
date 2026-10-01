import { describe, expect, it } from "vitest";

import {
  filterFor,
  projectForPath,
  sameFilter,
  toSaved,
  workspaceFor,
  workspaceName,
} from "@/lib/linearWorkspace";
import type { TrackerAccount } from "@/types/events";

const account = (id: string, name: string): TrackerAccount => ({
  tracker: "linear",
  userId: "u",
  userName: "U",
  orgName: name,
  workspaceId: id,
  urlKey: id,
});

const workspaces = [account("acme", "Acme"), account("jango", "JangoAI"), account("side", "Side")];
const pins = { JangoAI: "jango" };

// Held to Rust's `a_project_pin_beats_its_space_pin_which_beats_the_default`.
describe("linear workspace pins", () => {
  it("prefers the project's own pin, then its Space's, then the default", () => {
    expect(workspaceFor({ space: "JangoAI", linearWorkspace: "side" }, pins, workspaces)).toEqual({
      id: "side",
      from: "project",
    });
    expect(workspaceFor({ space: "JangoAI" }, pins, workspaces)).toEqual({
      id: "jango",
      from: "space",
    });
    expect(workspaceFor({ space: "Personal" }, pins, workspaces)).toEqual({
      id: "acme",
      from: "default",
    });
    expect(workspaceFor(null, pins, workspaces)).toEqual({
      id: "acme",
      from: "default",
    });
  });

  it("skips a pin to a workspace that is no longer connected", () => {
    expect(workspaceFor({ space: "JangoAI", linearWorkspace: "gone" }, pins, workspaces).id).toBe(
      "jango",
    );
    expect(workspaceFor({ space: "JangoAI" }, pins, [account("acme", "Acme")])).toEqual({
      id: "acme",
      from: "default",
    });
  });

  it("answers null with nothing connected", () => {
    expect(workspaceFor({ space: "JangoAI" }, pins, [])).toEqual({
      id: null,
      from: "default",
    });
  });

  it("names a workspace, falling back to the default and then the id", () => {
    expect(workspaceName(workspaces, "jango")).toBe("JangoAI");
    expect(workspaceName(workspaces, null)).toBe("Acme");
    expect(workspaceName(workspaces, "gone")).toBe("gone");
  });
});

describe("a repo's saved filter", () => {
  const saved = { workspace: "jango", teamId: "t1", teamName: "Mobile", labels: ["iOS"] };

  it("applies only in the workspace it was saved in", () => {
    expect(filterFor({ linearFilter: saved }, "jango")).toEqual({ teamId: "t1", labels: ["iOS"] });
    expect(filterFor({ linearFilter: saved }, "acme")).toBeNull();
    expect(filterFor({ linearFilter: saved }, null)).toBeNull();
    expect(filterFor({}, "jango")).toBeNull();
  });

  it("compares labels as a set", () => {
    expect(
      sameFilter(
        { teamId: null, labels: ["Web", "Backend"] },
        { teamId: null, labels: ["Backend", "Web"] },
      ),
    ).toBe(true);
    expect(sameFilter({ teamId: "t1", labels: [] }, { teamId: null, labels: [] })).toBe(false);
    expect(sameFilter(null, { teamId: null, labels: [] })).toBe(true);
  });

  it("saves nothing for a filter that narrows nothing", () => {
    expect(toSaved({ teamId: null, labels: [] }, "jango", null)).toBeNull();
    expect(toSaved({ teamId: null, labels: ["iOS"] }, "jango", "Mobile")).toEqual({
      workspace: "jango",
      teamId: undefined,
      teamName: undefined,
      labels: ["iOS"],
    });
  });
});

// Held to Rust's `a_worktree_belongs_to_the_project_it_sits_in`.
describe("finding a path's project", () => {
  const projects = [{ path: "/x/app" }, { path: "/x/app-web" }, { path: "/x" }];

  it("takes the innermost project the path sits in, by segment", () => {
    expect(projectForPath(projects, "/x/app")?.path).toBe("/x/app");
    expect(projectForPath(projects, "/x/app/.claude/worktrees/bold-fox")?.path).toBe("/x/app");
    // A string prefix would hand this to `/x/app`.
    expect(projectForPath(projects, "/x/app-web/src")?.path).toBe("/x/app-web");
    expect(projectForPath(projects, "/x/other")?.path).toBe("/x");
    expect(projectForPath(projects, "/elsewhere")).toBeNull();
    expect(projectForPath(projects, null)).toBeNull();
  });
});
