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

type Entry = Upload & { id: string; done: Promise<string> };

/// Keyed on server and local path, so a tile and the send that carries it find
/// one upload, and the same file pinned twice goes over once.
const uploads = new Map<string, Entry>();
/// Provisional prompt id → the uploads its send is waiting on.
const waiting = new Map<string, string[]>();
const { emit, subscribe } = channel<void>();

const keyOf = (server: ServerId, path: string) => `${server}\n${path}`;

/// One id per transfer, its key plus a count, so a file forgotten and pinned
/// again mid-upload is two transfers rather than one.
let transfers = 0;

/// Writes to transfer `id`'s entry, unless it was forgotten or replaced since:
/// a transfer still running after its tile went must not report for the one
/// that took its place.
function patch(id: string, change: Partial<Upload>) {
  const key = id.slice(0, id.lastIndexOf("\n"));
  const entry = uploads.get(key);
  if (entry?.id !== id) return;
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

  const id = `${key}\n${++transfers}`;
  const done =
    size > MAX_UPLOAD_BYTES
      ? Promise.reject(new Error("Over 100MB, the most a remote server takes."))
      : invoke<string>("upload_attachment", { server, path, id }, LOCAL);
  const settled = done.then(
    (landed) => {
      patch(id, { sent: size, path: landed });
      return landed;
    },
    (e: unknown) => {
      patch(id, { error: e instanceof Error ? e.message : String(e) });
      throw e;
    },
  );
  // A tile starts this and never awaits it; the failure is drawn, not thrown.
  settled.catch(() => {});
  uploads.set(key, { id, sent: 0, total: size, path: null, error: null, done: settled });
  emit();
  return settled;
}

/// Marks files already on `server` as uploaded to themselves: a prompt queued
/// there by another client and cancelled here names the server's copies, which
/// this Mac has no file behind.
export function alreadyThere(server: ServerId, paths: string[]) {
  for (const path of paths) {
    const key = keyOf(server, path);
    uploads.set(key, { id: `${key}\n${++transfers}`, sent: 0, total: 0, path, error: null, done: Promise.resolve(path) });
  }
  if (paths.length) emit();
}

/// Keeps every pinned file uploading: starts each one with no upload, now and
/// whenever one is forgotten — a send elsewhere may forget a file this tray
/// still holds. A failed one is left for the send to retry, or a file that
/// cannot go over would be retried on every emit. `files` is read at each
/// start rather than captured, since a tile taken off forgets its upload before
/// the tray re-renders, and a captured list would start it straight back up.
/// Answers the unsubscribe.
export function keepUploading(server: ServerId, files: () => { path: string; size: number }[]): () => void {
  const start = () => {
    for (const file of files()) {
      if (!uploads.has(keyOf(server, file.path))) void upload(server, file.path, file.size);
    }
  };
  start();
  return subscribe(start);
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
