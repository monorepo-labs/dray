import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/transport", () => ({
  LOCAL: "local",
  invoke: (...args: unknown[]) => invoke(...args),
  listen: () => Promise.resolve(() => {}),
}));

import { MAX_UPLOAD_BYTES, upload } from "@/lib/uploads";

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

  it("refuses a file over the cap without sending it", async () => {
    invoke.mockReset();
    await expect(upload("vps", "/big.mov", MAX_UPLOAD_BYTES + 1)).rejects.toThrow("100MB");
    expect(invoke).not.toHaveBeenCalled();
  });
});
