// The whole app against two real `dray-serve`s, in a plain browser: one stands
// in for the in-process core, the other is a remote server. Tauri's IPC is
// mocked, and the mock does in the page what `servers.rs` does in Rust — so
// everything above the transport is the shipping code, talking to real agents.
//
//   DRAY_HOME=/tmp/l dray-serve --port 7320 &       # "Local Server"
//   DRAY_HOME=/tmp/r dray-serve --port 7318 &       # a remote one
//   open "/demo/servers.html?local=$(cat /tmp/l/serve-token)&remote=$(cat /tmp/r/serve-token)"
//
// `&localUrl=` and `&remoteUrl=` move them; put a TCP proxy in front of the
// remote and kill it to watch the app lose and regain a server mid-turn.

import { emit } from "@tauri-apps/api/event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import React from "react";
import ReactDOM from "react-dom/client";
import "streamdown/styles.css";

import type { ServerInfo } from "@/types/events";

const query = new URLSearchParams(location.search);

type Call = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

/// One socket to a `dray-serve`, reopened a second after any drop.
function connect(url: string, token: string, onEvent: (event: string, payload: unknown) => void, onStatus: (s: ServerInfo["status"], error?: string) => void) {
  let ws: WebSocket | null = null;
  let admitted = false;
  let next = 0;
  // Turned off from Settings: the socket closes and nothing reopens it.
  let off = false;
  const pending = new Map<number, Call>();
  const open = () => {
    onStatus("connecting");
    admitted = false;
    ws = new WebSocket(url);
    ws.onopen = () => ws!.send(JSON.stringify({ v: 1, token }));
    ws.onmessage = ({ data }) => {
      const frame = JSON.parse(data);
      if (!admitted) {
        if ("err" in frame) return onStatus("disconnected", frame.err);
        admitted = true;
        return onStatus("connected");
      }
      if ("id" in frame) {
        const call = pending.get(frame.id);
        pending.delete(frame.id);
        if ("err" in frame) call?.reject(frame.err);
        else call?.resolve(frame.ok);
      } else onEvent(frame.event, frame.payload);
    };
    ws.onclose = () => {
      for (const call of pending.values()) call.reject("connection lost");
      pending.clear();
      onStatus("disconnected", off ? undefined : "connection lost");
      if (!off) setTimeout(open, 1000);
    };
  };
  // Next tick, so a caller's `onStatus` can name what this returns.
  setTimeout(open);
  return {
    call(cmd: string, args: unknown): Promise<unknown> {
      if (!ws || !admitted) return Promise.reject(`${url} is not connected`);
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws!.send(JSON.stringify({ id, cmd, args }));
      });
    },
    reconnect: () => ws?.close(),
    /// `set_server_on`: off closes for good, on reopens — or, for a socket
    /// still open, cycles it, which is what Try again asks for.
    setOn(on: boolean) {
      off = !on;
      if (on && (!ws || ws.readyState === WebSocket.CLOSED)) open();
      else ws?.close();
    },
  };
}

const local = connect(
  query.get("localUrl") ?? "ws://127.0.0.1:7320",
  query.get("local") ?? "",
  (event, payload) => void emit(event, payload),
  () => {},
);

type Remote = { info: ServerInfo; conn: ReturnType<typeof connect> };
const remotes: Remote[] = [];
const announce = () => void emit("servers_changed", remotes.map((r) => r.info));

function addRemote(url: string, token: string, name: string, id = crypto.randomUUID().slice(0, 8)): ServerInfo {
  const info: ServerInfo = { id, name, named: true, url, ssh: null, on: true, status: "connecting", stage: null, error: null, fix: null };
  const remote: Remote = {
    info,
    conn: connect(
      url,
      token,
      (event, payload) => void emit("server_event", { server: id, event, payload }),
      (status, error) => {
        remote.info = { ...remote.info, status, error: error ?? null };
        announce();
      },
    ),
  };
  remotes.push(remote);
  return info;
}

if (query.get("remote")) {
  addRemote(query.get("remoteUrl") ?? "ws://127.0.0.1:7319", query.get("remote")!, query.get("remoteName") ?? "vps", "vps1");
}

mockConvertFileSrc("macos");
mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "list_servers":
        return remotes.map((r) => r.info);
      case "add_server": {
        const url = String(a.url).replace(/^(?!ws:\/\/)/, "ws://");
        return addRemote(url, String(a.token), (a.name as string) ?? new URL(url).hostname);
      }
      case "remove_server":
        remotes.splice(remotes.findIndex((r) => r.info.id === a.id), 1);
        announce();
        return null;
      case "rename_server": {
        const remote = remotes.find((r) => r.info.id === a.id)!;
        const name = String(a.name).trim();
        remote.info = { ...remote.info, name: name || new URL(remote.info.url).hostname, named: !!name };
        announce();
        return null;
      }
      case "set_server_on": {
        const remote = remotes.find((r) => r.info.id === a.id)!;
        remote.info = { ...remote.info, on: !!a.on };
        remote.conn.setOn(!!a.on);
        announce();
        return null;
      }
      // SSH needs the Mac's own `ssh`, which a browser page cannot run.
      case "add_ssh_server":
        throw { message: "SSH is not available in the browser demo. Use an address and token.", fix: null };
      case "trust_host_key":
      case "run_server_login":
        throw "SSH is not available in the browser demo.";
      case "reconnect_servers":
        for (const r of remotes) r.conn.reconnect();
        return null;
      case "server_invoke": {
        const remote = remotes.find((r) => r.info.id === a.server);
        if (!remote) throw `no server named ${a.server}`;
        return remote.conn.call(String(a.cmd), a.args);
      }
      default:
        return local.call(cmd, a);
    }
  },
  { shouldMockEvents: true },
);

// After the mock: the app's modules reach for Tauri as they load.
const { default: App } = await import("@/App");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
