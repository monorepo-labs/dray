import { describe, expect, it } from "vitest";

import { chromiumBusy, chromiumPercent, describeChromium } from "./chromium";

describe("chromiumPercent", () => {
  it("floors, so a bar never reads done before the last byte", () => {
    expect(chromiumPercent({ state: "downloading", received: 999, total: 1000 })).toBe(99);
  });

  it("is zero for anything but a download, and for an empty total", () => {
    expect(chromiumPercent({ state: "downloading", received: 0, total: 0 })).toBe(0);
    expect(chromiumPercent({ state: "extracting" })).toBe(0);
  });
});

describe("describeChromium", () => {
  it("carries the percentage while downloading", () => {
    expect(describeChromium({ state: "downloading", received: 50, total: 200 })).toBe(
      "Downloading Chromium for the browser… 25%",
    );
  });

  it("names version and size once ready", () => {
    expect(describeChromium({ state: "ready", version: "151.3.24", sizeBytes: 327_000_000 })).toBe(
      "Chromium 151.3.24, 327 MB on disk.",
    );
  });

  it("repeats the backend's own words on failure", () => {
    expect(describeChromium({ state: "failed", message: "no route to host" })).toBe(
      "Chromium could not be downloaded: no route to host",
    );
  });
});

describe("chromiumBusy", () => {
  it("is true only while something is in flight", () => {
    expect(chromiumBusy({ state: "downloading", received: 1, total: 2 })).toBe(true);
    expect(chromiumBusy({ state: "extracting" })).toBe(true);
    expect(chromiumBusy({ state: "absent" })).toBe(false);
    expect(chromiumBusy({ state: "failed", message: "x" })).toBe(false);
  });
});
