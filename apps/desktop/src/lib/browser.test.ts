import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => 51234);
vi.mock("@/lib/transport", () => ({
  LOCAL: "local",
  invoke: (...args: unknown[]) => invoke(...(args as [])),
  listen: () => Promise.resolve(() => undefined),
  serverOfSession: (id: string) => (id === "remote" ? "vps" : "local"),
}));

const { reachableUrl } = await import("@/lib/browser");

describe("reachableUrl", () => {
  it("forwards a remote session's loopback port, keeping the path", async () => {
    expect(await reachableUrl("remote", "http://127.0.0.1:3000/a?b=1#c")).toBe("http://localhost:51234/a?b=1#c");
    expect(invoke).toHaveBeenLastCalledWith("forward_port", { server: "vps", port: 3000 }, "local");
    await reachableUrl("remote", "http://localhost/");
    expect(invoke).toHaveBeenLastCalledWith("forward_port", { server: "vps", port: 80 }, "local");
  });

  it("leaves local sessions, public hosts and non-URLs alone", async () => {
    invoke.mockClear();
    expect(await reachableUrl("mine", "http://localhost:3000")).toBe("http://localhost:3000");
    expect(await reachableUrl("remote", "https://example.com")).toBe("https://example.com");
    expect(await reachableUrl("remote", "not a url")).toBe("not a url");
    expect(invoke).not.toHaveBeenCalled();
  });
});
