// One socket to a real `dray-serve`, for the demos that run the whole app in a
// plain browser with Tauri's IPC mocked: servers.html and cloud.html.

import type { ServerInfo } from "@/types/events";

type Call = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

/// One socket to a `dray-serve`, reopened a second after any drop.
export function connect(url: string, token: string, onEvent: (event: string, payload: unknown) => void, onStatus: (s: ServerInfo["status"], error?: string) => void) {
  let ws: WebSocket | null = null;
  let admitted = false;
  let next = 0;
  // Turned off from Settings: the socket closes and nothing reopens it.
  let off = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, Call>();
  const open = () => {
    clearTimeout(retry);
    if (off) return;
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
      if (!off) retry = setTimeout(open, 1000);
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
      clearTimeout(retry);
      if (on && (!ws || ws.readyState === WebSocket.CLOSED)) open();
      else ws?.close();
    },
  };
}

export type Socket = ReturnType<typeof connect>;
