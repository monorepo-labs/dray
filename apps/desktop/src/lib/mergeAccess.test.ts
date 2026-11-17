import { describe, expect, it } from "vitest";

import { blockReason } from "@/lib/mergeAccess";

const base = { machine: "box", slug: "acme/app", here: "yo", there: "yo", can: true as boolean | null | undefined };

describe("blockReason", () => {
  it("offers Merge where this account can write and is the one the machine used", () => {
    expect(blockReason(base)).toBeNull();
    // A machine never heard from is not held against.
    expect(blockReason({ ...base, there: undefined })).toBeNull();
  });

  it("holds Merge for a different account, even one that could merge", () => {
    expect(blockReason({ ...base, there: "bot-account" })).toBe(
      "box used GitHub as bot-account, and this machine is signed in as yo. Merge once box is back.",
    );
  });

  it("names the machine the merge runs through", () => {
    expect(blockReason({ ...base, merger: "studio", can: false })).toBe(
      "Studio's GitHub account (yo) can't merge into acme/app. Merge once box is back.",
    );
  });

  it("holds Merge without write access, and while it cannot tell", () => {
    expect(blockReason({ ...base, can: false })).toBe(
      "This machine's GitHub account (yo) can't merge into acme/app. Merge once box is back.",
    );
    expect(blockReason({ ...base, can: null })).toMatch(/^Couldn't check/);
    expect(blockReason({ ...base, can: undefined })).toMatch(/^Checking/);
  });
});
