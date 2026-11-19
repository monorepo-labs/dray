import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

function page(href: string) {
  const url = new URL(href);
  const replaceState = vi.fn((_: unknown, __: string, next: string) => {
    const moved = new URL(next, url);
    url.search = moved.search;
    url.hash = moved.hash;
  });
  vi.stubGlobal("location", {
    get protocol() {
      return url.protocol;
    },
    get host() {
      return url.host;
    },
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    get hash() {
      return url.hash;
    },
    reload: vi.fn(),
  });
  vi.stubGlobal("history", { replaceState });
  return { url, replaceState };
}

describe("webApp", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a token from the address and drops it from the bar", async () => {
    const { url } = page("http://100.64.0.1:7317/web/?token=abc&tab=files#top");
    const { webToken } = await import("./webApp");
    expect(webToken()).toBe("abc");
    expect(url.search).toBe("?tab=files");
    expect(url.hash).toBe("#top");
    expect(localStorage.getItem("dray.webToken")).toBe("abc");
  });

  it("reads a kept token on a later load", async () => {
    localStorage.setItem("dray.webToken", "kept");
    const { replaceState } = page("http://localhost:7317/web/");
    const { webToken } = await import("./webApp");
    expect(webToken()).toBe("kept");
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("has no token on a first visit without one", async () => {
    page("http://localhost:7317/web/");
    const { webToken } = await import("./webApp");
    expect(webToken()).toBeNull();
  });

  it("forgets a refused token and says so once", async () => {
    localStorage.setItem("dray.webToken", "stale");
    page("http://localhost:7317/web/");
    const { refuseWebToken, tokenWasRefused } = await import("./webApp");
    refuseWebToken();
    expect(localStorage.getItem("dray.webToken")).toBeNull();
    expect(location.reload).toHaveBeenCalled();
    expect(tokenWasRefused()).toBe(true);
    expect(tokenWasRefused()).toBe(false);
  });

  it("connects back to the server that served the page", async () => {
    page("https://dray.example.test/web/");
    const { webServerUrl } = await import("./webApp");
    expect(webServerUrl()).toBe("wss://dray.example.test");
    vi.resetModules();
    page("http://127.0.0.1:7317/web/");
    expect((await import("./webApp")).webServerUrl()).toBe("ws://127.0.0.1:7317");
  });
});
