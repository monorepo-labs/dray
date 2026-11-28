import { beforeAll, describe, expect, it, vi } from "vitest";

import { networkOffline, offlineFailure, subscribeNetwork } from "@/lib/network";
import { offlineLine, offlineReason, offlineSubject, remoteServers, subscribeServers } from "@/lib/servers";
import { listen, LOCAL } from "@/lib/transport";
import type { ServerInfo } from "@/types/events";

vi.mock("@/lib/transport", async (actual) => ({
  ...(await actual<typeof import("@/lib/transport")>()),
  invoke: vi.fn(() => new Promise(() => {})),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const handlers = new Map<string, (e: { payload: unknown; server: string }) => void>();

function say(event: string, payload: unknown) {
  handlers.get(event)?.({ payload, server: LOCAL });
}

const server = (over: Partial<ServerInfo>): ServerInfo =>
  ({ id: "vps", name: "vps", on: true, status: "disconnected", error: "could not reach ws://vps: IO error", ...over }) as ServerInfo;

beforeAll(() => {
  vi.mocked(listen).mockImplementation(((event: string, handler: (e: { payload: unknown; server: string }) => void) => {
    handlers.set(event, handler);
    return Promise.resolve(() => {});
  }) as typeof listen);
  subscribeServers(() => {});
  subscribeNetwork(() => {});
});

describe("the offline line", () => {
  it("names the server and its error while the network is fine", () => {
    say("network_changed", false);
    say("servers_changed", [server({})]);
    expect(offlineLine("vps")).toBe("vps is offline · could not reach ws://vps: IO error");
  });

  it("says this machine is offline instead, the same for every server, with no error", () => {
    say("servers_changed", [server({}), server({ id: "box", name: "box" })]);
    say("network_changed", true);
    expect(networkOffline()).toBe(true);
    expect(offlineLine("vps")).toBe("You're offline");
    expect(offlineLine("box")).toBe("You're offline");
  });

  it("keeps Reconnecting only while a connect is under way", () => {
    say("servers_changed", [server({ status: "connecting" })]);
    expect(offlineLine("vps")).toBe("You're offline · Reconnecting…");
  });

  it("leaves a server turned off as its own reason", () => {
    const off = server({ on: false });
    expect(offlineSubject(off)).toBe("vps is offline");
    expect(offlineReason(off)).toBe("turned off");
  });

  it("hands readers a new list when the network moves, so they draw again", () => {
    const before = remoteServers();
    say("network_changed", false);
    expect(remoteServers()).not.toBe(before);
    expect(offlineLine("vps")).toBe("vps is offline · Reconnecting…");
  });
});

describe("offlineFailure", () => {
  it("drops connection failures only while offline", () => {
    say("network_changed", false);
    expect(offlineFailure("lost the connection to vps")).toBe(false);
    say("network_changed", true);
    expect(offlineFailure("lost the connection to vps")).toBe(true);
    expect(offlineFailure("vps is not connected")).toBe(true);
    expect(offlineFailure("Attach a project first.")).toBe(false);
  });
});
