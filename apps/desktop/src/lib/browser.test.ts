import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => 51234);
vi.mock("@/lib/transport", () => ({
  LOCAL: "local",
  invoke: (...args: unknown[]) => invoke(...(args as [])),
  listen: () => Promise.resolve(() => undefined),
  serverOfSession: (id: string) => (id === "remote" ? "vps" : "local"),
}));

const { reachableUrl, browserTarget, normalizeUrl, pageColour, stoppedServer } = await import("@/lib/browser");

type Tab = Parameters<typeof stoppedServer>[0];
const tab = (url: string, error: string | null, loading = false): Tab => ({
  id: 7,
  url,
  title: "",
  favicon: "",
  loading,
  active: true,
  canGoBack: false,
  canGoForward: false,
  error,
});

describe("browserTarget", () => {
  it("reads loopback, .localhost, .local and private LAN hosts as localhost", () => {
    for (const url of [
      "http://localhost:5173/",
      "http://LOCALHOST:3000",
      "http://app.localhost:8080/x",
      "http://127.0.0.1:3000",
      "http://127.4.5.6",
      "http://[::1]:3000/",
      "http://0.0.0.0:8000",
      "http://10.0.0.7:3000",
      "http://172.16.0.1",
      "http://172.31.255.255:80",
      "http://192.168.1.20:5173",
      "http://mac-mini.local:3000",
      "https://dev.local",
    ]) {
      expect(browserTarget(url), url).toBe("localhost");
    }
  });

  it("reads every other http(s) page as a site", () => {
    for (const url of [
      "https://example.com",
      "https://localhost.example.com",
      "http://localhost.evil.test:3000",
      "https://GitHub.com/a/b",
      "http://172.15.0.1",
      "http://172.32.0.1",
      "http://11.0.0.1",
      "http://8.8.8.8",
      "http://[2001:db8::1]/",
      "https://local.example.com",
    ]) {
      expect(browserTarget(url), url).toBe("site");
    }
  });

  it("reports nothing for what is no web page", () => {
    expect(browserTarget("about:blank")).toBeNull();
    expect(browserTarget("data:text/html,hi")).toBeNull();
    expect(browserTarget("not a url")).toBeNull();
    expect(browserTarget("")).toBeNull();
  });

  it("classifies URL-bar input once normalized", () => {
    expect(browserTarget(normalizeUrl("localhost:5173"))).toBe("localhost");
    expect(normalizeUrl("192.168.1.20:5173/app")).toBe("http://192.168.1.20:5173/app");
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(browserTarget(normalizeUrl("[::1]:3000"))).toBe("localhost");
    expect(browserTarget(normalizeUrl("example.com"))).toBe("site");
    expect(browserTarget(normalizeUrl("how to center a div"))).toBe("site");
  });
});

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

describe("stoppedServer", () => {
  it("names the session and real port behind a forward the server dropped", async () => {
    invoke.mockResolvedValueOnce(52011);
    await reachableUrl("remote", "http://localhost:3000");
    const dead = stoppedServer(tab("http://localhost:52011/", "net::ERR_EMPTY_RESPONSE"), "bot");
    expect(dead).toMatchObject({ port: 3000, sessionId: "remote", retrying: false });
  });

  it("reads a refused port on this machine as the browser's own, where nothing recorded it", () => {
    expect(stoppedServer(tab("http://localhost:4000/", "net::ERR_CONNECTION_REFUSED"), "mine")).toMatchObject({
      port: 4000,
      sessionId: "mine",
    });
    // A remote session's browser on this Mac's port: nobody to ask.
    expect(stoppedServer(tab("http://localhost:4000/", "net::ERR_CONNECTION_REFUSED"), "remote")?.sessionId).toBeNull();
  });

  it("ignores other failures, other hosts and healthy pages", () => {
    expect(stoppedServer(tab("http://localhost:4001/", "net::ERR_EMPTY_RESPONSE"), "mine")).toBeNull();
    expect(stoppedServer(tab("https://example.com/", "net::ERR_CONNECTION_REFUSED"), "mine")).toBeNull();
    expect(stoppedServer(tab("http://localhost:4001/", null), "mine")).toBeNull();
  });
});

describe("pageColour", () => {
  it("drops the colour Chromium's error page reports under a stopped server's page", () => {
    const white = "rgb(255, 255, 255)";
    expect(pageColour({ ...tab("http://localhost:4002/", "net::ERR_CONNECTION_REFUSED"), background: white }, "mine")).toBeNull();
    expect(pageColour({ ...tab("http://localhost:4002/", null), background: white }, "mine")).toBe(white);
  });
});
