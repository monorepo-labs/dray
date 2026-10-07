import { describe, expect, it } from "vitest";

import { announcement, compareVersions, forChannel, type Release } from "@/lib/changelog";

const rel = (version: string, notify = false): Release => ({
  version,
  date: null,
  notify,
  beta: version.includes("-"),
  sections: [],
});

describe("compareVersions", () => {
  it("orders by number, prerelease below its release", () => {
    expect(compareVersions("0.27.0", "0.26.9")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.27.0-beta.1", "0.27.0")).toBeLessThan(0);
    expect(compareVersions("0.27.0-beta.10", "0.27.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("0.27.0", "0.27.0")).toBe(0);
  });
});

describe("announcement", () => {
  const feed = [rel("0.29.0", true), rel("0.28.0", true), rel("0.27.0"), rel("0.26.0", true)];

  it("announces the newest flagged release past seen that is running", () => {
    const next = announcement(feed, "0.28.0", "0.27.0", false);
    expect(next.release?.version).toBe("0.28.0");
    expect(next.seen).toBe("0.28.0");
  });

  it("never announces a release ahead of the build", () => {
    expect(announcement(feed, "0.27.0", "0.27.0", false).release).toBeNull();
  });

  it("stays quiet once seen", () => {
    expect(announcement(feed, "0.28.0", "0.28.0", false).release).toBeNull();
  });

  it("a fresh install has seen everything", () => {
    const next = announcement(feed, "0.28.0", null, true);
    expect(next.release).toBeNull();
    expect(next.seen).toBe("0.28.0");
  });

  it("an existing install meeting the feature gets the newest flagged one", () => {
    expect(announcement(feed, "0.28.0", null, false).release?.version).toBe("0.28.0");
  });

  it("an unflagged release moves seen without a card", () => {
    const next = announcement(feed, "0.27.0", "0.26.0", false);
    expect(next.release).toBeNull();
    expect(next.seen).toBe("0.27.0");
  });
});

it("hides betas off the beta channel", () => {
  const feed = [rel("0.27.0-beta.1"), rel("0.26.0")];
  expect(forChannel(feed, "stable").map((r) => r.version)).toEqual(["0.26.0"]);
  expect(forChannel(feed, "beta")).toHaveLength(2);
});
