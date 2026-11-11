import { describe, expect, it } from "vitest";

import { serverShown, unreachable, withKept } from "@/lib/serverCache";
import { qualify } from "@/lib/transport";
import type { ServerInfo } from "@/types/events";

const server = (id: string, over: Partial<ServerInfo> = {}): ServerInfo =>
  ({ id, name: id, on: true, status: "connected", ...over }) as ServerInfo;
const row = (path: string) => ({ path });
const pathOf = (r: { path: string }) => r.path;

const here = row("/code/dray");
const boxRow = row(qualify("/srv/dray", "box"));
const kept = row(qualify("/srv/web", "box"));

describe("serverShown", () => {
  it("shows This Mac, and a remote while listed and on", () => {
    expect(serverShown("local", [])).toBe(true);
    expect(serverShown("box", [server("box", { status: "disconnected" })])).toBe(true);
    expect(serverShown("box", [server("box", { on: false })])).toBe(false);
    expect(serverShown("box", [])).toBe(false);
  });
});

describe("unreachable", () => {
  it("names servers that are on and not connected", () => {
    const list = [
      server("up"),
      server("down", { status: "disconnected" }),
      server("trying", { status: "connecting" }),
      server("off", { on: false, status: "disconnected" }),
    ];
    expect(unreachable(list)).toEqual(["down", "trying"]);
  });
});

describe("withKept", () => {
  it("hides a server turned off, and one removed", () => {
    const prev = [here, boxRow];
    expect(withKept(prev, [server("box", { on: false })], [], () => undefined, pathOf)).toEqual([here]);
    expect(withKept(prev, [], [], () => undefined, pathOf)).toEqual([here]);
  });

  it("draws an unreachable server's kept rows where it draws none", () => {
    const list = [server("box", { status: "disconnected" })];
    expect(withKept([here], list, ["box"], () => [kept], pathOf)).toEqual([here, kept]);
  });

  it("keeps rows already on screen over the kept ones, which are older", () => {
    const list = [server("box", { status: "disconnected" })];
    expect(withKept([here, boxRow], list, ["box"], () => [kept], pathOf)).toEqual([here, boxRow]);
  });

  it("answers the same array when nothing moves, so React skips the render", () => {
    const prev = [here, boxRow];
    expect(withKept(prev, [server("box")], [], () => undefined, pathOf)).toBe(prev);
  });
});
