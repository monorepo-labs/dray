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
/// `update` is the autosave path: it compares before writing, so restoring a
/// draft's own picks on open moves nothing, and it debounces so a keystroke is
/// not a file rewrite. `remove` cancels a pending write, or a draft sent a
/// moment after typing would be written back after it was deleted.
export function useDrafts(onError: (e: unknown) => void) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    invoke<Draft[]>("list_drafts").then(setDrafts, (e) => errorRef.current(e));
  }, []);

  const write = useCallback((draft: Draft) => {
    invoke("save_draft", { draft }).catch((e) => errorRef.current(e));
  }, []);

  const save = useCallback(
    (draft: Draft) => {
      clearTimeout(pending.current.get(draft.id));
      pending.current.delete(draft.id);
      setDrafts((prev) =>
        prev.some((d) => d.id === draft.id)
          ? prev.map((d) => (d.id === draft.id ? draft : d))
          : [...prev, draft],
      );
      write(draft);
    },
    [write],
  );

  const update = useCallback(
    (id: string, patch: Partial<Omit<Draft, "id" | "created">>) => {
      const current = draftsRef.current.find((d) => d.id === id);
      if (!current) return;
      const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
        (k) => patch[k] !== current[k],
      );
      if (!changed) return;
      const next = { ...current, ...patch };
      draftsRef.current = draftsRef.current.map((d) => (d.id === id ? next : d));
      setDrafts(draftsRef.current);
      clearTimeout(pending.current.get(id));
      pending.current.set(
        id,
        setTimeout(() => {
          pending.current.delete(id);
          write(next);
        }, SAVE_DELAY_MS),
      );
    },
    [write],
  );

  const remove = useCallback((id: string) => {
    clearTimeout(pending.current.get(id));
    pending.current.delete(id);
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    invoke("delete_draft", { id }).catch((e) => errorRef.current(e));
  }, []);

  return { drafts, save, update, remove };
}
