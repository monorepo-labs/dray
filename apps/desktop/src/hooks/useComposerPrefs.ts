import { useCallback } from "react";

import { useLocalStorage } from "@/hooks/useLocalStorage";
import type { ModelByHarness } from "@/lib/model";
import type { ApprovalPolicy, Effort, Harness, ModelId } from "@/types/events";

/// Seeds for a first run with nothing stored. Once the user picks anything, their
/// pick is the default — these are never read again.
///
/// No model is seeded: an empty map means "never picked one", which
/// `rememberedModel` answers per harness. A single seeded id could only ever be
/// right for one of them.
const SEED: ComposerPrefs = {
  harness: "claude_code",
  modelByHarness: {},
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
type ComposerPrefs = {
  /// Which agent a new session starts on. Sticky like the rest of this row —
  /// somebody who works in Codex should not re-pick it every time.
  harness: Harness;
  /// Keyed by harness, because a harness cannot run the other's models at all.
  /// One id here was the whole of the bug it replaced: switching agent and back
  /// found a pick the new list could not run and fell to whatever led it.
  modelByHarness: ModelByHarness;
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
