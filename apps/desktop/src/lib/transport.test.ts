import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { cmd: string; args: unknown }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
  invoke: async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    if (cmd === "server_invoke") {
      const inner = (args as { cmd: string }).cmd;
      if (inner === "list_projects") return [{ path: "/root/app", name: "app" }];
    }
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { displayPath, fileSrc, invoke, qualify, serverOfSession, splitPath } = await import("./transport");

beforeEach(() => {
  calls.length = 0;
});

describe("paths", () => {
  it("round-trips a remote path and leaves a local one alone", () => {
    expect(qualify("/root/app", "vps1")).toBe("dray://vps1/root/app");
    expect(splitPath("dray://vps1/root/app")).toEqual({ server: "vps1", path: "/root/app" });
    expect(displayPath("dray://vps1/root/app")).toBe("/root/app");
    expect(qualify("/Users/me/app", "local")).toBe("/Users/me/app");
    expect(qualify("src/a.ts", "vps1")).toBe("src/a.ts");
  });

  it("keeps a token out of a remote file's URL", () => {
    expect(fileSrc("dray://vps1/x/a.png")).toBe("drayserver://localhost/?server=vps1&path=%2Fx%2Fa.png");
  });
});

describe("invoke", () => {
  it("sends a local call to Tauri untouched", async () => {
    await invoke("work_status", { cwd: "/Users/me/app" });
    expect(calls).toEqual([{ cmd: "work_status", args: { cwd: "/Users/me/app" } }]);
  });

  it("routes by a qualified argument and unwraps it", async () => {
    await invoke("send_msg", { sessionId: "s1", cwd: "dray://vps1/root/app", attachmentPaths: [] });
    expect(calls[0]).toEqual({
      cmd: "server_invoke",
      args: { server: "vps1", cmd: "send_msg", args: { sessionId: "s1", cwd: "/root/app", attachmentPaths: [] } },
    });
    // The session learned its server, so the next call needs no path.
    expect(serverOfSession("s1")).toBe("vps1");
    await invoke("interrupt_session", { sessionId: "s1" });
    expect((calls[1].args as { server: string }).server).toBe("vps1");
  });

  it("keeps a Mac-side command local whatever session it names", async () => {
    await invoke("notify_session", { sessionId: "s1" });
    expect(calls[0].cmd).toBe("notify_session");
  });

  it("refuses one call naming two servers", async () => {
    await expect(invoke("x", { a: "dray://one/a", b: "dray://two/b" })).rejects.toThrow(/two servers/);
  });

  it("qualifies the paths a remote answer carries", async () => {
    expect(await invoke("list_projects", {}, "vps1")).toEqual([{ path: "dray://vps1/root/app", name: "app" }]);
  });
});
