import { useSyncExternalStore } from "react";

/// The plan a session's agent last put up for approval, per session, in memory.
///
/// **In memory because the wire gives it nowhere else to live.** grok sends the
/// text on the `_x.ai/exit_plan_mode` *request*, and a permission request is
/// never persisted — only the child that asked can answer it, so a replayed one
/// is a card whose buttons cannot work. The `exit_plan_mode` tool call beside it
/// carries an empty input, so nothing in the log holds the plan either. A
/// restart therefore opens with no plan, the same bargain `useOpenFiles` makes,
/// and that is the honest state rather than a gap to paper over.
///
/// It outlives the *card*, deliberately: approving a plan is the moment the
/// reader most wants to keep reading it, so the tab stays until the agent puts
/// up another or the app restarts.
const bySession = new Map<string, string>();

let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getVersion = () => version;

/// Records a plan, ignoring a repeat of the one already held.
///
/// The guard is what makes this callable from an effect that re-runs on every
/// session event: without it each one would emit and re-render every subscriber
/// for a string that had not moved.
export function setPlan(sessionId: string | null, plan: string): void {
  if (!sessionId || !plan) return;
  if (bySession.get(sessionId) === plan) return;
  bySession.set(sessionId, plan);
  emit();
}

/// The plan a held tool call carries, or `null` where it is not a plan at all.
///
/// Keyed on the tool's name and not on the input having a `plan` field: both
/// harnesses that plan spell the tool the same way bar the casing, and a field
/// match would adopt any future tool that happened to take an argument called
/// `plan`.
export function planAsked(toolName: string, input: unknown): string | null {
  if (toolName !== "exit_plan_mode" && toolName !== "ExitPlanMode") return null;
  if (!input || typeof input !== "object") return null;
  const plan = (input as Record<string, unknown>).plan;
  return typeof plan === "string" && plan.trim() ? plan : null;
}

export function planFor(sessionId: string | null): string | null {
  return sessionId ? bySession.get(sessionId) ?? null : null;
}

export function forgetPlan(sessionId: string): void {
  if (bySession.delete(sessionId)) emit();
}

/// The session's plan, or `null`. Drives whether the panel draws a Plan tab.
export function usePlan(sessionId: string | null): string | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return planFor(sessionId);
}
