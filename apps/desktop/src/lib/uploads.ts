import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";
import { invoke, listen, LOCAL, type ServerId } from "@/lib/transport";

/// The most a remote server takes per attachment — `MAX_UPLOAD_BYTES` in
/// attachments.rs, stated again so a tile refuses before a byte moves.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/// One file on its way to a remote server. A remote session cannot read a path
/// on this Mac, so a pinned attachment is sent over at once and the send names
/// the server's copy, `path`, instead.
export type Upload = {
  sent: number;
  total: number;
  path: string | null;
  error: string | null;
};

type Entry = Upload & { done: Promise<string> };

/// Keyed on server and local path, so a tile and the send that carries it find
/// one upload, and the same file pinned twice goes over once.
const uploads = new Map<string, Entry>();
/// Provisional prompt id → the uploads its send is waiting on.
const waiting = new Map<string, string[]>();
const { emit, subscribe } = channel<void>();

const keyOf = (server: ServerId, path: string) => `${server}\n${path}`;

function patch(key: string, change: Partial<Upload>) {
  const entry = uploads.get(key);
  if (!entry) return;
  uploads.set(key, { ...entry, ...change });
  emit();
}

let listening = false;

/// Sends `path` to `server` unless it is already on its way or there, and
/// answers where it lands. A failed upload starts over, so the send retries
/// whatever a dropped connection lost.
export function upload(server: ServerId, path: string, size: number): Promise<string> {
  const key = keyOf(server, path);
  const current = uploads.get(key);
  if (current && !current.error) return current.done;

  if (!listening) {
    listening = true;
    void listen<{ id: string; sent: number; total: number }>("upload_progress", ({ payload }) =>
      patch(payload.id, { sent: payload.sent, total: payload.total }),
    );
  }

  const done =
    size > MAX_UPLOAD_BYTES
      ? Promise.reject(new Error("Over 100MB, the most a remote server takes."))
      : invoke<string>("upload_attachment", { server, path, id: key }, LOCAL);
  const settled = done.then(
    (landed) => {
      patch(key, { sent: size, path: landed });
      return landed;
    },
    (e: unknown) => {
      patch(key, { error: e instanceof Error ? e.message : String(e) });
      throw e;
    },
  );
  // A tile starts this and never awaits it; the failure is drawn, not thrown.
  settled.catch(() => {});
  uploads.set(key, { sent: 0, total: size, path: null, error: null, done: settled });
  emit();
  return settled;
}

/// Drops these uploads, so the file is read and sent again the next time it is
/// pinned — after a send has used it, or a tile was taken off. Kept, a file
/// edited and attached again would go over as it was the first time.
export function forget(server: ServerId, paths: string[]) {
  for (const path of paths) uploads.delete(keyOf(server, path));
  emit();
}

/// Draws `eventId`'s bubble as waiting on these uploads until `stopWaiting`.
export function waitFor(eventId: string, server: ServerId, paths: string[]) {
  waiting.set(eventId, paths.map((path) => keyOf(server, path)));
  emit();
}

export function stopWaiting(eventId: string) {
  if (waiting.delete(eventId)) emit();
}

/// One tile's upload, or `undefined` where nothing has been sent for it.
export function useUpload(server: ServerId, path: string): Upload | undefined {
  return useSyncExternalStore(subscribe, () => uploads.get(keyOf(server, path)));
}

/// How far a send held on its uploads has got, 0–1 by bytes, or `null` for a
/// prompt not held.
export function useSendProgress(eventId: string): number | null {
  return useSyncExternalStore(subscribe, () => {
    const keys = waiting.get(eventId);
    if (!keys) return null;
    let sent = 0;
    let total = 0;
    for (const key of keys) {
      const entry = uploads.get(key);
      sent += entry?.sent ?? 0;
      total += entry?.total ?? 0;
    }
    return total ? sent / total : 0;
  });
}
