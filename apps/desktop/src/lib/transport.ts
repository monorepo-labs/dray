// The one door to the Rust core. Inside the desktop app it is Tauri's own
// `invoke` and `listen`; pointed at a `dray-serve` it is a WebSocket speaking
// the same two calls. See SERVE-PLAN.md and src-tauri/src/serve.rs.
//
// A server is named by the page's URL: `?token=…`, plus `&server=ws://…`
// for anything but the default.

import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

/** Stated again from serve.rs's `PROTOCOL`; the server refuses a mismatch by name. */
const PROTOCOL = 1;
const DEFAULT_SERVER = "ws://127.0.0.1:7317";

type Remote = { url: string; token: string };

function remoteServer(): Remote | null {
  if (typeof location === "undefined") return null;
  const query = new URLSearchParams(location.search);
  const token = query.get("token");
  return token ? { url: query.get("server") ?? DEFAULT_SERVER, token } : null;
}

const remote = remoteServer();

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };

const pending = new Map<number, Pending>();
const listeners = new Map<string, Set<EventCallback<unknown>>>();
let nextId = 0;
let socket: Promise<WebSocket> | null = null;

/** Opens the socket and settles once the server has admitted us. */
function connect(server: Remote): Promise<WebSocket> {
  socket ??= new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(server.url);
    let admitted = false;
    ws.onopen = () => ws.send(JSON.stringify({ v: PROTOCOL, token: server.token }));
    ws.onmessage = ({ data }) => {
      const frame = JSON.parse(data);
      if (!admitted) {
        if ("err" in frame) return reject(new Error(`dray-serve refused: ${frame.err}`));
        admitted = true;
        return resolve(ws);
      }
      if ("id" in frame) {
        const call = pending.get(frame.id);
        pending.delete(frame.id);
        if ("err" in frame) call?.reject(frame.err);
        else call?.resolve(frame.ok);
      } else {
        for (const handler of listeners.get(frame.event) ?? []) {
          handler({ event: frame.event, id: 0, payload: frame.payload });
        }
      }
    };
    ws.onclose = () => {
      socket = null;
      if (!admitted) reject(new Error(`could not reach dray-serve at ${server.url}`));
      for (const call of pending.values()) call.reject("connection to dray-serve closed");
      pending.clear();
      // Something is waiting on events, and nothing else would reopen the
      // socket for it. Events sent while it was closed are lost; a reload
      // re-reads everything.
      if (listeners.size > 0) setTimeout(() => void connect(server).catch(() => {}), 1000);
    };
  });
  return socket;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!remote) return tauriInvoke<T>(cmd, args);
  const ws = await connect(remote);
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    ws.send(JSON.stringify({ id, cmd, args: args ?? {} }));
  });
}

/// A URL the webview can load a local file through: Tauri's asset protocol
/// here, the server's `/file` route there. The server serves attachments and
/// browser recordings alone, so any other path answers 404 remotely.
export function fileSrc(path: string): string {
  if (!remote) return convertFileSrc(path);
  const base = remote.url.replace(/^ws/, "http").replace(/\/+$/, "");
  const query = new URLSearchParams({ token: remote.token, path });
  return `${base}/file?${query}`;
}

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  if (!remote) return tauriListen<T>(event, handler);
  const set = listeners.get(event) ?? new Set();
  listeners.set(event, set);
  set.add(handler as EventCallback<unknown>);
  // Not awaited: Tauri's `listen` never fails for a server being down, and a
  // failed open retries on its own while a listener is registered.
  connect(remote).catch(() => {});
  return () => {
    set.delete(handler as EventCallback<unknown>);
    if (set.size === 0) listeners.delete(event);
  };
}
