import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ApprovalPolicy, Effort, Harness, ModelId } from "@/types/events";

/// A task written and saved but not started: the prompt plus the composer picks
/// it will start with. Stored whole in `~/.dray/drafts.json`, which Rust keeps
/// untyped — this is the only statement of the shape.
///
/// No branch: picking one checks it out, so restoring it would move the tree.
export type Draft = {
  id: string;
  prompt: string;
  projectPath: string;
  harness: Harness;
  model: ModelId;
  effort: Effort | null;
  permissionMode: ApprovalPolicy;
  fast: boolean;
  useWorktree: boolean;
  created: string;
};

/// The composer key an open draft's text lives under in `useDraft`, apart from
/// the new-task composer's `null` so opening a draft never overwrites text the
/// reader was typing there. Never a session id, which is a bare uuid.
export const draftKey = (id: string) => `draft:${id}`;

/// What a draft's row says: its first line, or a word for none.
export function draftTitle(draft: Draft): string {
  return draft.prompt.trim().split("\n")[0].trim() || "Empty draft";
}

/// How long typing settles before an open draft's text is written.
const SAVE_DELAY_MS = 400;

/// The saved drafts, and writes that keep the file in step.
///
/// The ref is the truth and `drafts` a copy for rendering. `update` is the
/// autosave path and moves the ref alone, publishing with its debounced write
/// — published per keystroke it re-rendered all of `App` while typing. It
/// compares first, so restoring a draft's own picks on open writes nothing.
///
/// Every write goes through one queue, so Rust takes them in the order they
/// were made: two invokes race for the file lock, and a save already in flight
/// could land after the delete that followed it and bring the draft back.
export function useDrafts(onError: (e: unknown) => void) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const ref = useRef<Draft[]>([]);
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const queue = useRef(Promise.resolve());
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const publish = useCallback((next: Draft[]) => {
    ref.current = next;
    setDrafts(next);
  }, []);

  /// Answers whether the write landed; a failure is reported here already.
  const enqueue = useCallback((command: string, args: Record<string, unknown>) => {
    const done = queue.current.then(() =>
      invoke<void>(command, args).then(
        () => true,
        (e) => {
          errorRef.current(e);
          return false;
        },
      ),
    );
    queue.current = done.then(() => {});
    return done;
  }, []);

  useEffect(() => {
    invoke<Draft[]>("list_drafts").then(
      // Merged, not taken whole: a draft saved while this was out is already
      // here and on its way to the file.
      (loaded) => publish([...loaded.filter((d) => !ref.current.some((r) => r.id === d.id)), ...ref.current]),
      (e) => errorRef.current(e),
    );
  }, [publish]);

  const cancelPending = (id: string) => {
    clearTimeout(pending.current.get(id));
    pending.current.delete(id);
  };

  /// Listed only once it is on disk, and answers whether it got there: the
  /// caller clears the composer on that answer, so a failed write leaves the
  /// text where the reader typed it.
  const save = useCallback(
    async (draft: Draft) => {
      cancelPending(draft.id);
      if (!(await enqueue("save_draft", { draft }))) return false;
      publish([...ref.current.filter((d) => d.id !== draft.id), draft]);
      return true;
    },
    [publish, enqueue],
  );

  const update = useCallback(
    (id: string, patch: Partial<Omit<Draft, "id" | "created">>) => {
      const current = ref.current.find((d) => d.id === id);
      if (!current) return;
      const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
        (k) => patch[k] !== current[k],
      );
      if (!changed) return;
      ref.current = ref.current.map((d) => (d.id === id ? { ...current, ...patch } : d));
      cancelPending(id);
      pending.current.set(
        id,
        setTimeout(() => {
          pending.current.delete(id);
          const draft = ref.current.find((d) => d.id === id);
          if (!draft) return;
          setDrafts(ref.current);
          enqueue("save_draft", { draft });
        }, SAVE_DELAY_MS),
      );
    },
    [enqueue],
  );

  const remove = useCallback(
    (id: string) => {
      cancelPending(id);
      publish(ref.current.filter((d) => d.id !== id));
      enqueue("delete_draft", { id });
    },
    [publish, enqueue],
  );

  /// The draft as it stands, ahead of the render the debounce holds back.
  const get = useCallback((id: string) => ref.current.find((d) => d.id === id), []);

  /// Removes a draft left with no text: it says nothing and would only clutter
  /// the list. Read off the saved prompt, not the composer's, which a send
  /// clears before anyone knows whether the session started.
  const discardIfEmpty = useCallback(
    (id: string) => {
      if (get(id)?.prompt.trim() === "") remove(id);
    },
    [get, remove],
  );

  return { drafts, save, update, remove, get, discardIfEmpty };
}
