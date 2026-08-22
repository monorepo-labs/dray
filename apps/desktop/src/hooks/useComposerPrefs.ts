import { useCallback } from "react";

import { useLocalStorage } from "@/hooks/useLocalStorage";
import type { ApprovalPolicy, Effort, ModelId } from "@/types/events";

/// Seeds for a first run with nothing stored. Once the user picks anything, their
/// pick is the default — these are never read again.
const SEED: ComposerPrefs = {
  modelId: "haiku",
  effortByModel: {},
  permissionMode: "auto",
  useWorktree: false,
};

/// Effort is a property of the model, not of the picker: switching to Sonnet must
/// not inherit the Max you last chose on Opus. Absent key = use the model default.
export type EffortByModel = Partial<Record<ModelId, Effort>>;

/// What a new session starts with. Deliberately not the whole composer: `branch`
/// seeds from whatever the repo is checked out to, since restoring a name without
/// running the checkout would have the composer claim a branch the tree isn't on;
/// `projectPath` is already persisted backend-side by `set_last_selected_project`.
export type ComposerPrefs = {
  modelId: ModelId;
  effortByModel: EffortByModel;
  permissionMode: ApprovalPolicy;
  useWorktree: boolean;
};

/// The sticky half of the composer. Every control the user can change writes here,
/// so "I always want acceptEdits on Sonnet" survives both a session switch and a
/// relaunch, and `handleNewSession` seeds from it instead of from a constant.
///
/// Restoring a *session's* settings must never write here — clicking through old
/// sessions would otherwise rewrite the defaults behind the user's back.
export function useComposerPrefs() {
  const [prefs, setPrefs] = useLocalStorage<ComposerPrefs>("ade.composerPrefs", SEED);

  // Merged over the seed on read, so a record written by an older build that
  // lacks a key gets the seed for it rather than `undefined` reaching a picker.
  const merged: ComposerPrefs = { ...SEED, ...prefs };

  const patch = useCallback(
    (next: Partial<ComposerPrefs>) => setPrefs((prev) => ({ ...SEED, ...prev, ...next })),
    [setPrefs],
  );

  return [merged, patch] as const;
}
