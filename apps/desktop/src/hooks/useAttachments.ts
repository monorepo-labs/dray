import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { Attachment } from "@/types/events";

/// What is pinned to the composer but not yet sent, keyed by the session it was
/// attached to. `null` is the new task's own key, exactly as in `useDraft` — and
/// for the same reason: `AppShell` moves the footer when it is centered, so
/// crossing from the empty state into a session unmounts `ChatInput` and mounts
/// a fresh one. Anything held in component state would be lost on that switch.
///
/// Module-level also because there are two writers in two places. The `+` button
/// lives in `ComposerToolbar`, which is passed to `ChatInput` as an opaque
/// `ReactNode`, so the two cannot pass props to each other — they share this
/// instead, and neither has to know the other exists.
///
/// Not persisted: an attachment is part of a sentence you were in the middle of,
/// and the file it points at may not survive a restart either.
const bySession = new Map<string | null, Attachment[]>();
const listeners = new Set<() => void>();

/// Everything the backend has described this run, keyed by path — the identity
/// the composer already dedupes on. Never invalidated: an attachment is a
/// reading of a file taken when the user picked it, and the row that reads one
/// back is drawing what they attached rather than what the file says now.
const byPath = new Map<string, Attachment>();

// One frozen array for every empty key. `useSyncExternalStore` re-renders on any
// snapshot that isn't reference-equal to the last, so minting `[]` per read
// would loop forever.
const EMPTY: Attachment[] = [];

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function remember(attachments: Attachment[]) {
  for (const attachment of attachments) byPath.set(attachment.path, attachment);
  return attachments;
}

function write(sessionId: string | null, next: Attachment[]) {
  if (next.length) bySession.set(sessionId, next);
  else bySession.delete(sessionId);
  emit();
}

/// Describes each path in the backend and pins the ones that can be attached.
/// Deduped on path, so dropping the same screenshot twice pins one — the path is
/// the identity, and a second copy of one file says nothing the first didn't.
export async function addAttachmentPaths(sessionId: string | null, paths: string[]) {
  const current = bySession.get(sessionId) ?? EMPTY;
  const fresh = paths.filter((path) => !current.some((a) => a.path === path));
  if (!fresh.length) return;

  const added = remember(await invoke<Attachment[]>("read_attachments", { paths: fresh }));
  if (!added.length) return;

  // Re-read rather than closing over `current`: the dialog and the reads above
  // are both awaited, and a drop landing in between must not be dropped.
  const now = bySession.get(sessionId) ?? EMPTY;
  write(sessionId, [...now, ...added.filter((a) => !now.some((b) => b.path === a.path))]);
}

/// Opens the system file picker and pins whatever comes back. Resolves to
/// nothing when the user cancels.
export async function pickAttachments(sessionId: string | null) {
  const picked = await open({ multiple: true, title: "Attach files" });
  if (!picked) return;

  await addAttachmentPaths(sessionId, Array.isArray(picked) ? picked : [picked]);
}

export function removeAttachment(sessionId: string | null, path: string) {
  const current = bySession.get(sessionId);
  if (!current) return;

  write(
    sessionId,
    current.filter((a) => a.path !== path),
  );
}

export function clearAttachments(sessionId: string | null) {
  if (!bySession.has(sessionId)) return;
  write(sessionId, EMPTY);
}

/// One session's pending attachments. Read-only — every mutation is a
/// module-level function above, so a caller that only writes (the toolbar's `+`)
/// takes no subscription and re-renders for nothing.
export function useAttachments(sessionId: string | null): Attachment[] {
  const getSnapshot = useCallback(() => bySession.get(sessionId) ?? EMPTY, [sessionId]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

function fromCache(paths: string[]): Attachment[] {
  if (!paths.length) return EMPTY;

  const found = paths.flatMap((path) => {
    const attachment = byPath.get(path);
    return attachment ? [attachment] : [];
  });

  return found.length ? found : EMPTY;
}

/// What the backend says about a list of paths, described once and remembered.
///
/// The queued row's own read, and it needs one: a held prompt carries paths and
/// not attachments, because they are resolved at flush so that a cancel hands
/// the composer back exactly what was typed. Asking is also the only honest way
/// to draw one — whether a file travels as pixels is decided by extension *and*
/// size in Rust, and a second copy of that rule here would be free to disagree
/// with what actually goes down the wire.
///
/// A path `read_attachments` skips — a file cleared out from under a prompt
/// still holding it — caches nothing and is simply absent from the answer, so a
/// later mount asks again rather than remembering a gap.
export function useAttachmentsByPath(paths: string[]): Attachment[] {
  const key = paths.join("\0");
  const [read, setRead] = useState(() => ({ key, attachments: fromCache(paths) }));

  useEffect(() => {
    const wanted = key ? key.split("\0") : [];
    if (wanted.every((path) => byPath.has(path))) return;

    let live = true;
    void describeUncached(wanted).then(() => {
      if (live) setRead({ key, attachments: fromCache(wanted) });
    });
    return () => {
      live = false;
    };
  }, [key]);

  // Taken from the cache during render rather than only in the effect above:
  // state alone leaves one frame of the previous prompt's pictures sitting
  // under this one's text.
  return read.key === key ? read.attachments : fromCache(paths);
}

async function describeUncached(paths: string[]) {
  const missing = paths.filter((path) => !byPath.has(path));
  if (!missing.length) return;

  remember(await invoke<Attachment[]>("read_attachments", { paths: missing }));
}
