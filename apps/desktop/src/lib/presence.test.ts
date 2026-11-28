import { describe, expect, it } from "vitest";

import { due, RENEW_MS, type Said } from "./presence";

const serverOf = (id: string) => (id.startsWith("vps-") ? "vps" : "local");
const said = (entries: [string, Said][]) => new Map(entries);

describe("due", () => {
  it("tells each server only its own chats", () => {
    const out = due(["vps-a", "b", "vps-c"], true, serverOf, said([]), 0);
    expect(Object.fromEntries(out)).toEqual({ vps: ["vps-a", "vps-c"], local: ["b"] });
  });

  it("says nothing new until the lease is due", () => {
    const told = said([["vps", { key: "vps-a", at: 0 }]]);
    expect(due(["vps-a"], true, serverOf, told, RENEW_MS - 1).size).toBe(0);
    expect(due(["vps-a"], true, serverOf, told, RENEW_MS).get("vps")).toEqual(["vps-a"]);
  });

  it("lets go at once when the reader looks away", () => {
    const told = said([["vps", { key: "vps-a", at: 0 }]]);
    expect(due(["vps-a"], false, serverOf, told, 1).get("vps")).toEqual([]);
    expect(due(["b"], true, serverOf, told, 1).get("vps")).toEqual([]);
  });

  it("tells a server holding nothing nothing", () => {
    expect(due(["vps-a"], false, serverOf, said([]), 0).size).toBe(0);
  });
});
