import { describe, expect, it } from "vitest";

import { forgetClosedTabs, moveKey, popClosedTab, pushClosedTab, reconcile } from "./tabOrder";

describe("forgetClosedTabs", () => {
  it("drops a deleted task's tab from its bot's closed list", () => {
    pushClosedTab("bot", { key: "task:t1" });
    pushClosedTab("bot", { key: "task:t2" });
    forgetClosedTabs("t2");
    expect(popClosedTab("bot")?.key).toBe("task:t1");
    expect(popClosedTab("bot")).toBeUndefined();
  });

  it("drops a closed pick on a deleted task, keeping others", () => {
    pushClosedTab("bot", { key: "pick:1", pick: { kind: "changes", target: "t1" } });
    pushClosedTab("bot", { key: "pick:2", pick: { kind: "files", target: "t2" } });
    forgetClosedTabs("t2");
    expect(popClosedTab("bot")?.key).toBe("pick:1");
    expect(popClosedTab("bot")).toBeUndefined();
  });
});

describe("reconcile", () => {
  it("keeps the reader's order and appends what is new", () => {
    expect(reconcile(["changes", "chat"], ["chat", "changes", "file:/a"])).toEqual([
      "changes",
      "chat",
      "file:/a",
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

  it("trades a pick's slot with its own files and no other pick's", () => {
    expect(reconcile(["pick:1", "pick:2", "chat"], ["chat", "pick:2", "pickfile:1:/a:b"])).toEqual([
      "pickfile:1:/a:b",
      "pick:2",
      "chat",
    ]);
    expect(reconcile(["pickfile:1:/a", "chat"], ["chat", "pick:1"])).toEqual(["pick:1", "chat"]);
    expect(reconcile(["pick:1", "chat"], ["chat", "pickfile:2:/a"])).toEqual(["chat", "pickfile:2:/a"]);
  });

  it("never lets one kind take another's slot", () => {
    expect(reconcile(["chat", "page:1"], ["chat", "file:/a"])).toEqual(["chat", "file:/a"]);
  });
});

describe("moveKey", () => {
  it("moves a key to the index the drag answered", () => {
    expect(moveKey(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });
});
