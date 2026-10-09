import { describe, expect, it } from "vitest";

import { moveKey, reconcile } from "./tabOrder";

describe("reconcile", () => {
  it("keeps the reader's order and appends what is new", () => {
    expect(reconcile(["changes", "chat"], ["chat", "changes", "file:/a"])).toEqual([
      "changes",
      "chat",
      "file:/a",
    ]);
  });

  it("puts the first page where the Browser stand-in was", () => {
    expect(reconcile(["chat", "browser", "changes"], ["chat", "page:1", "changes"])).toEqual([
      "chat",
      "page:1",
      "changes",
    ]);
  });

  it("puts a new tab's page where the new tab was", () => {
    expect(
      reconcile(["page:1", "blank:1", "chat"], ["chat", "page:1", "page:2"]),
    ).toEqual(["page:1", "page:2", "chat"]);
  });

  it("puts Files back where the last file was", () => {
    expect(reconcile(["file:/a", "chat"], ["chat", "files"])).toEqual(["files", "chat"]);
  });

  it("never lets one kind take another's slot", () => {
    expect(reconcile(["chat", "browser"], ["chat", "file:/a"])).toEqual(["chat", "file:/a"]);
  });
});

describe("moveKey", () => {
  it("moves a key to the index the drag answered", () => {
    expect(moveKey(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });
});
