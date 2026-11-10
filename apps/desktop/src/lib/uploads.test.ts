import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/transport", () => ({
  LOCAL: "local",
  splitPath: (path: string) => {
    const m = /^dray:\/\/([^/]+)(\/.*)$/.exec(path);
    return m ? { server: m[1], path: m[2] } : { server: "local", path };
  },
  invoke: (...args: unknown[]) => invoke(...args),
  listen: () => Promise.resolve(() => {}),
}));

import { forget, keepUploading, MAX_UPLOAD_BYTES, upload } from "@/lib/uploads";

describe("upload", () => {
  it("sends a file once, and again only after it failed", async () => {
    invoke.mockReset();
    invoke.mockRejectedValueOnce("connection reset").mockResolvedValueOnce("/srv/a.png");

    await expect(upload("vps", "/a.png", 10)).rejects.toBe("connection reset");
    const retried = upload("vps", "/a.png", 10);
    expect(upload("vps", "/a.png", 10)).toBe(retried);
    await expect(retried).resolves.toBe("/srv/a.png");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("passes a server's own copy through, and never confuses it with a local file", async () => {
    invoke.mockReset();
    invoke.mockResolvedValueOnce("/srv/ctx.txt");

    await expect(upload("vps", "dray://vps/tmp/ctx.txt", 10)).resolves.toBe("/tmp/ctx.txt");
    await expect(upload("box", "dray://vps/tmp/ctx.txt", 10)).rejects.toThrow();
    // The same path on this Mac is still read and sent.
    await expect(upload("vps", "/tmp/ctx.txt", 10)).resolves.toBe("/srv/ctx.txt");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("sends a file again once a send has used it", async () => {
    invoke.mockReset();
    invoke.mockResolvedValueOnce("/srv/1/b.txt").mockResolvedValueOnce("/srv/2/b.txt");

    await expect(upload("vps", "/b.txt", 10)).resolves.toBe("/srv/1/b.txt");
    forget("vps", ["/b.txt"]);
    await expect(upload("vps", "/b.txt", 10)).resolves.toBe("/srv/2/b.txt");
  });

  it("lets a forgotten transfer's late failure say nothing about its replacement", async () => {
    invoke.mockReset();
    let failFirst!: (e: string) => void;
    invoke
      .mockReturnValueOnce(new Promise((_, reject) => (failFirst = reject)))
      .mockResolvedValueOnce("/srv/c.log");

    const first = upload("vps", "/c.log", 10);
    forget("vps", ["/c.log"]);
    const second = upload("vps", "/c.log", 10);
    failFirst("reset");
    await expect(first).rejects.toBe("reset");
    await expect(second).resolves.toBe("/srv/c.log");
    // Still the replacement's upload, not restarted on the old error.
    expect(upload("vps", "/c.log", 10)).toBe(second);
  });

  it("starts a pinned file again when forgotten, and a removed one never", async () => {
    invoke.mockReset();
    invoke.mockResolvedValue("/srv/d.png");

    let pinned = [{ path: "/d.png", size: 10 }];
    const stop = keepUploading("vps", () => pinned);
    await upload("vps", "/d.png", 10);
    forget("vps", ["/d.png"]);
    expect(invoke).toHaveBeenCalledTimes(2);

    // Taken off the tray before the tray re-renders: forgotten, and left so.
    pinned = [];
    forget("vps", ["/d.png"]);
    expect(invoke).toHaveBeenCalledTimes(2);
    stop();
  });

  it("refuses a file over the cap without sending it", async () => {
    invoke.mockReset();
    await expect(upload("vps", "/big.mov", MAX_UPLOAD_BYTES + 1)).rejects.toThrow("100MB");
    expect(invoke).not.toHaveBeenCalled();
  });
});
