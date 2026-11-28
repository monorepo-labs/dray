import { describe, expect, it } from "vitest";

import {
  announcement,
  compareVersions,
  desktopHighlights,
  forChannel,
  settle,
  type ChangelogApp,
  type ChangelogItem,
  type Release,
} from "@/lib/changelog";

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
    const next = announcement(feed, "0.28.0", "0.27.0");
    expect(next.release?.version).toBe("0.28.0");
    expect(next.seen).toBe("0.28.0");
  });

  it("never announces a release ahead of the build", () => {
    expect(announcement(feed, "0.27.0", "0.27.0").release).toBeNull();
  });

  it("stays quiet once seen", () => {
    expect(announcement(feed, "0.28.0", "0.28.0").release).toBeNull();
  });

  it("a fresh install, seeded with its own version, has seen everything", () => {
    const next = announcement(feed, "0.28.0", "0.28.0");
    expect(next.release).toBeNull();
    expect(next.seen).toBe("0.28.0");
  });

  it("an existing install meeting the feature gets the newest flagged one", () => {
    expect(announcement(feed, "0.28.0", null).release?.version).toBe("0.28.0");
  });

  it("an unflagged release moves seen without a card", () => {
    const next = announcement(feed, "0.27.0", "0.26.0");
    expect(next.release).toBeNull();
    expect(next.seen).toBe("0.27.0");
  });
});

it("hides betas off the beta channel", () => {
  const feed = [rel("0.27.0-beta.1"), rel("0.26.0")];
  expect(forChannel(feed, "stable").map((r) => r.version)).toEqual(["0.26.0"]);
  expect(forChannel(feed, "beta")).toHaveLength(2);
});

describe("highlights", () => {
  const item = (title: string, apps: ChangelogApp[] | null): ChangelogItem => ({
    title,
    body: "",
    media: [],
    highlight: apps && { apps, action: null },
  });
  const withItems = (version: string, notify: boolean, items: ChangelogItem[]): Release => ({
    ...rel(version, notify),
    sections: [{ kind: "new", items }],
  });
  const feed = [
    withItems("0.30.0", false, [item("Big", ["desktop"]), item("Phone", ["ios"]), item("Small", null)]),
    withItems("0.29.0", true, [item("Older", ["desktop", "android"])]),
    withItems("0.28.0", true, [item("Card only", null)]),
  ];

  it("pages every desktop highlight past seen, newest release first, and no card", () => {
    const next = announcement(feed, "0.30.0", "0.28.0");
    expect(next.highlights.map((h) => h.item.title)).toEqual(["Big", "Older"]);
    expect(next.highlights[0].version).toBe("0.30.0");
    expect(next.release).toBeNull();
    expect(next.seen).toBe("0.30.0");
  });

  it("a release with no desktop highlights keeps the card", () => {
    const next = announcement(feed, "0.28.0", "0.27.0");
    expect(next.highlights).toEqual([]);
    expect(next.release?.version).toBe("0.28.0");
  });

  it("an install from before the feature hears of the newest release alone", () => {
    expect(announcement(feed, "0.30.0", null).highlights.map((h) => h.item.title)).toEqual(["Big"]);
  });

  it("puts a required highlight first, from whichever release it came", () => {
    const must = { ...item("Pair again", ["desktop"]), highlight: { apps: ["desktop" as const], action: null, required: true } };
    const withMust = [feed[0], withItems("0.29.0", true, [item("Older", ["desktop"]), must]), feed[2]];
    const titles = announcement(withMust, "0.30.0", "0.28.0").highlights.map((h) => h.item.title);
    expect(titles).toEqual(["Pair again", "Big", "Older"]);
  });

  it("settles a conditional highlight by the reader's Remote access", () => {
    const relay: ChangelogItem = {
      title: "Reconnect your phone and other Macs. Remote access is now more reliable and faster",
      body: "",
      media: [],
      highlight: {
        apps: ["desktop"],
        action: { label: "Open Servers settings", target: "settings/servers" },
        required: "remote-access",
        otherwise: "Remote access is now more reliable and faster",
      },
    };
    const withRelay = [withItems("0.30.0", true, [item("Big", ["desktop"]), relay])];

    const on = announcement(withRelay, "0.30.0", "0.29.0", { remoteAccess: true }).highlights;
    expect(on.map((h) => h.item.title?.slice(0, 9))).toEqual(["Reconnect", "Big"]);
    expect(on[0].item.highlight).toMatchObject({ required: true, action: { target: "settings/servers" } });

    const off = announcement(withRelay, "0.30.0", "0.29.0", { remoteAccess: false }).highlights;
    expect(off.map((h) => h.item.title)).toEqual(["Big", "Remote access is now more reliable and faster"]);
    expect(off[1].item.highlight).toMatchObject({ required: false, action: null });
  });

  it("reads a condition this build does not know as not holding", () => {
    const h = { version: "0.30.0", item: { ...item("X", ["desktop"]), highlight: { apps: ["desktop" as const], action: null, required: "on-a-boat", otherwise: "Y" } } };
    expect(settle(h, { remoteAccess: true }).item).toMatchObject({ title: "Y", highlight: { required: false } });
  });

  it("reads a feed built before highlights existed", () => {
    const old = withItems("0.30.0", true, [{ title: "X", body: "", media: [] }]);
    expect(desktopHighlights(old)).toEqual([]);
    expect(announcement([old], "0.30.0", "0.29.0").release?.version).toBe("0.30.0");
  });
});
