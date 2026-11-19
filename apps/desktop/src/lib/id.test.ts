import { afterEach, describe, expect, it, vi } from "vitest";

import { newId } from "./id";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the native generator where it exists", () => {
    expect(newId()).toMatch(V4);
  });

  it("falls back to getRandomValues on an insecure page", () => {
    const { getRandomValues } = crypto;
    vi.stubGlobal("crypto", { getRandomValues: getRandomValues.bind(crypto) });
    expect(typeof crypto.randomUUID).toBe("undefined");
    const a = newId();
    const b = newId();
    expect(a).toMatch(V4);
    expect(b).toMatch(V4);
    expect(a).not.toBe(b);
  });
});
