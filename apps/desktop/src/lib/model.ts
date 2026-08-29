import type { Model, ModelId } from "@/types/events";

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
export function usableModel(models: Model[], picked: ModelId): ModelId {
  if (models.length === 0 || models.some((m) => m.id === picked)) return picked;
  return models[0].id;
}
