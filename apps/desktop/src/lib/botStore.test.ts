import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerInfo } from "@/types/events";

// Each server's answer to `list_bots`, or an error to throw.
const answers = new Map<string, unknown>();
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: async (cmd: string, args: { server: string; cmd: string; args: unknown }) => {
    if (cmd !== "server_invoke") return null;
    const answer = answers.get(args.server);
    if (answer instanceof Error) throw answer.message;
    if (args.cmd === "list_bots") return answer ?? [];
    if (args.cmd === "bot_previews") {
      const ids = (args.args as { sessionIds: string[] }).sessionIds;
      return Object.fromEntries(ids.map((id) => [id, { text: `${args.server}:${id}`, replies: 0 }]));
    }
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

let list: ServerInfo[] = [];
vi.mock("@/lib/servers", () => ({
  remoteServers: () => list,
  subscribeServers: () => () => {},
}));

const { botsOf, keepBots, readPreviews, refreshBots, serverOfBot } = await import("./bots");
const { noteSession } = await import("./transport");

const server = (id: string, over: Partial<ServerInfo> = {}): ServerInfo =>
  ({ id, name: id, on: true, status: "connected", ...over }) as ServerInfo;
const bot = (id: string, path: string) => ({ id, name: id, path, created: "" });

beforeEach(() => {
  answers.clear();
  list = [server("box")];
});

describe("bot store", () => {
  it("qualifies a remote's bots, so each knows its server", async () => {
    answers.set("box", [bot("ops", "/root/.dray/bots/ops")]);
    await refreshBots("box");
    const [ops] = botsOf("box") ?? [];
    expect(ops.path).toBe("dray://box/root/.dray/bots/ops");
    expect(serverOfBot(ops)).toBe("box");
  });

  it("keeps an unreachable remote's bots, and empties an older one's", async () => {
    answers.set("box", [bot("ops", "/b/ops")]);
    await refreshBots("box");
    answers.set("box", new Error("box is not connected"));
    await refreshBots("box");
    expect(botsOf("box")).toHaveLength(1);
    answers.set("box", new Error("unknown command: list_bots"));
    await refreshBots("box");
    expect(botsOf("box")).toEqual([]);
  });

  it("lets a kept list stand in only until the server answers", async () => {
    keepBots("cold", [bot("old", "dray://cold/x")]);
    expect(botsOf("cold")).toHaveLength(1);
    answers.set("cold", []);
    await refreshBots("cold");
    keepBots("cold", [bot("old", "dray://cold/x")]);
    expect(botsOf("cold")).toEqual([]);
  });

  it("asks each chat's own server for its preview", async () => {
    noteSession("remote-chat", "box");
    const previews = await readPreviews(["local-chat", "remote-chat"]);
    expect(previews["local-chat"].text).toBe("local:local-chat");
    expect(previews["remote-chat"].text).toBe("box:remote-chat");
  });
});
