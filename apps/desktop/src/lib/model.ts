import type { Harness, Model, ModelId } from "@/types/events";

/// What each harness opens on before its reader has picked anything, and what a
/// session indexed without a model reads back as.
///
/// The strong model in both cases, deliberately: the picker is one click away
/// for anyone who wants cheaper, where a weak default costs a turn that has to
/// be redone by hand. Mirrors `default_model_for` in `models/models.rs` — two
/// readers that cannot call each other, so the rule is stated twice.
export const DEFAULT_MODEL_FOR: Record<Harness, ModelId> = {
  claude_code: "opus",
  codex: "gpt56_sol",
};

/// Which model each harness was last left on. Absent key = never picked one.
export type ModelByHarness = Partial<Record<Harness, ModelId>>;

/// The model to open a harness on: what it was last left on, else its default.
///
/// Per-harness because a model belongs to exactly one of them, so a single
/// remembered pick can only ever be right for the harness that made it.
/// Switching to Codex and back used to land on whichever model the new list
/// happened to start with — a pick nobody made, and one that read as the
/// composer forgetting.
export function rememberedModel(remembered: ModelByHarness, harness: Harness): ModelId {
  return remembered[harness] ?? DEFAULT_MODEL_FOR[harness];
}

/// The model to run, given a pick and the list the current harness can run.
///
/// A model belongs to exactly one harness, so a pick made under the other one
/// names something this harness cannot run — and the pick is stored, so it
/// outlives the switch that made it. Every place that seeds the composer's
/// model has to ask this: repairing only where the harness *changes* leaves the
/// stored default free to name the old harness's model forever, and it reaches
/// the backend as a session started on a model nobody chose.
///
/// An empty list means the models have not arrived yet, so the pick stands —
/// the fetch that fills the list repairs it a beat later.
///
/// A pick it has to replace falls to the harness's default, not to whatever
/// leads the list: the head of the list is a picker-ordering decision, and
/// reading it as an answer is what put sessions on Fable and Sol.
export function usableModel(models: Model[], picked: ModelId, harness: Harness): ModelId {
  if (models.length === 0 || models.some((m) => m.id === picked)) return picked;
  const fallback = DEFAULT_MODEL_FOR[harness];
  return models.some((m) => m.id === fallback) ? fallback : models[0].id;
}
