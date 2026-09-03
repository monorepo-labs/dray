import { describe, expect, it } from "vitest";

import {
  activeSpace,
  displayPath,
  inSpace,
  sessionInSpace,
  spaceNames,
} from "@/lib/space";
import type { Project } from "@/types/events";

const project = (path: string, space: string | null): Project => ({
  path,
  name: path,
  space,
  lastSelected: "2026-08-01T00:00:00Z",
});

const projects = [
  project("/work/api", "Work"),
  project("/work/web", "Work"),
  project("/me/blog", "Personal"),
  project("/me/scratch", null),
];

describe("spaces", () => {
  it("lists tags and declared names as one set, sorted", () => {
    expect(spaceNames(projects)).toEqual(["Personal", "Work"]);
    // A space just made holds nothing, and a name is not doubled by being both
    // declared and carried.
    expect(spaceNames(projects, ["Work", "Side"])).toEqual([
      "Personal",
      "Side",
      "Work",
    ]);
  });

  it("falls back to every project when the stored space no longer exists", () => {
    expect(activeSpace(projects, "Work")).toBe("Work");
    expect(activeSpace(projects, "Gone")).toBeNull();
    // An empty space is still a space, or switching to one just made would
    // silently show every session in the app.
    expect(activeSpace(projects, "Side", ["Side"])).toBe("Side");
  });

  it("holds only its own projects, and holds all of them with no space", () => {
    expect(inSpace(projects, "Work").map((p) => p.path)).toEqual([
      "/work/api",
      "/work/web",
    ]);
    expect(inSpace(projects, null)).toHaveLength(4);
    expect(inSpace(projects, "Side")).toEqual([]);
  });

  it("hides a session whose project is filed elsewhere or nowhere", () => {
    expect(sessionInSpace(projects, "Work", "/work/api")).toBe(true);
    expect(sessionInSpace(projects, "Work", "/me/blog")).toBe(false);
    expect(sessionInSpace(projects, "Work", "/me/scratch")).toBe(false);
    // Nothing is hidden until a space is chosen, including a project the app
    // has never heard of.
    expect(sessionInSpace(projects, null, "/elsewhere")).toBe(true);
  });

  it("drops the leading slash and nothing else", () => {
    expect(displayPath("/Users/y/proj")).toBe("Users/y/proj");
    expect(displayPath("C:/proj")).toBe("C:/proj");
  });
});
