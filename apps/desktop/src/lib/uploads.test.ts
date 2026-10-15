import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/transport", () => ({
  LOCAL: "local",
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

  it("starts a pinned file again when a send elsewhere forgets it", async () => {
    invoke.mockReset();
    invoke.mockResolvedValue("/srv/d.png");

    const stop = keepUploading("vps", [{ path: "/d.png", size: 10 }]);
    await upload("vps", "/d.png", 10);
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
