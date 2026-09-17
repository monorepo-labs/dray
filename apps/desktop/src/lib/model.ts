import type { Effort, Harness, Model, ModelId } from "@/types/events";

/// The one spelling of "nothing here can name the model".
///
/// Written by an index entry made before the model was known, and by an older
/// build that read an id it did not recognise. `models.rs` holds the same
/// constant and normalises the older `"unknown"` onto it on the way in, so this
/// is the only spelling that reaches the frontend.
///
/// **Never drawn.** It is not a model name and there is no name to draw — a
/// surface holding one shows the picker's own placeholder instead.
export const UNSET_MODEL = "" as ModelId;

export function isUnsetModel(id: ModelId): boolean {
  return id === UNSET_MODEL;
}

/// What each harness opens on before its reader has picked anything, and what a
/// session indexed without a model reads back as.
///
/// The strong model where there is one, deliberately: the picker is one click
/// away for anyone who wants cheaper, where a weak default costs a turn that
/// has to be redone by hand. Mirrors `default_model_for` in `models/models.rs`
/// — two readers that cannot call each other, so the rule is stated twice.
///
/// pi names none, and that is the honest answer rather than a gap. It is
/// multi-provider, so any constant here might name a model the reader has no
/// key for — and pi's own settings already say which one they want. The
/// composer reads that back instead of seeding it.
export const DEFAULT_MODEL_FOR: Record<Harness, ModelId> = {
  claude_code: "opus",
  codex: "gpt56_sol",
  pi: UNSET_MODEL,
  // Multi-provider like pi, and its settings file already names a model.
  fx: UNSET_MODEL,
};

/// The providers `fx provider` takes, in fx's own words. Fixed by fx's CLI
/// (`fx provider <gateway|codex|grok>`), not discovered — the *models* are.
/// `label` is fx's own full name for the tooltip; `short` is our own text for
/// the segmented provider control, where three full names would not fit.
export const FX_PROVIDERS: { id: string; label: string; short: string }[] = [
  { id: "gateway", label: "Vercel AI Gateway", short: "Vercel" },
  { id: "codex", label: "Codex subscription", short: "Codex" },
  { id: "grok", label: "Grok subscription", short: "Grok" },
];

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

  // A harness naming no default answers the sentinel, never the head of the
  // list: pi picks for itself, and the spawn omits the flag. A pick this list
  // cannot run — the other harness's model, or one whose provider was logged
  // out — falls to "let pi decide", where landing on the list's first model
  // put a session on a model the reader never chose, with nothing on screen
  // saying so. Same answer for the unset pick.
  if (isUnsetModel(fallback)) return UNSET_MODEL;

  return models.some((m) => m.id === fallback) ? fallback : models[0].id;
}

/// fx's model repair, per provider. fx lists one provider at a time, so a pick
/// made under another provider names a model this list cannot run — and unlike
/// [`usableModel`], the fall-back is not the unset sentinel outright but the
/// model this provider was **last left on**, so switching providers and back
/// returns to where you were. Only when that too is gone does it fall to the
/// sentinel (fx picks for itself), never to the head of the list.
///
/// `picks` is the reader's last model per provider; the caller reads it, so this
/// stays pure and testable.
export function usableFxModel(
  list: Model[],
  picked: ModelId,
  picks: Record<string, ModelId>,
): ModelId {
  if (list.length === 0 || list.some((m) => m.id === picked)) return picked;
  const remembered = picks[list[0]?.provider ?? ""];
  if (remembered && list.some((m) => m.id === remembered)) return remembered;
  return UNSET_MODEL;
}

/// The provider serving this model, from the lists fx has answered so far, or
/// `undefined` where none of them names it. What lets a session's model say
/// which provider it belongs to without a field on the index for it.
export function fxProviderOf(cache: Record<string, Model[]>, id: ModelId): string | undefined {
  if (isUnsetModel(id)) return undefined;
  return Object.keys(cache).find((provider) => cache[provider].some((m) => m.id === id));
}

/// The fx list the composer draws: the one serving `picked`, where the cache
/// knows it, else `active` — the list fx's global provider last answered.
///
/// fx's provider is one setting for the whole machine, and the composer used to
/// draw its list from that alone — so switching provider in one session put the
/// new provider's thumb and rows under every other fx session's picker, drew
/// their models as bare ids, and let ⇧⇥ cycle them onto the wrong provider.
/// The pick is per session and names its provider, so the list follows it.
export function fxListFor(
  cache: Record<string, Model[]>,
  picked: ModelId,
  active: Model[],
): Model[] {
  const own = fxProviderOf(cache, picked);
  if (!own || own === active[0]?.provider) return active;
  return cache[own] ?? active;
}

/// The effort a model will actually run at, given what the reader last picked
/// for it.
///
/// A remembered pick outlives the answer that made it offerable, and fx is
/// where that bites: its ladder is per model and only a live session can state
/// it, so a level picked off the provider's guess can stop being on the list
/// the moment a session reports the truth (DRA-221). Left unchecked the trigger
/// names a level the menu beside it no longer offers, and the next send asks
/// for it again — which is the state the reader complained about in the first
/// place.
///
/// A model that takes no effort answers `null`, which is what hides the control
/// entirely. Otherwise the first offered level of: the pick, the model's own
/// default, the app's — [`usableModel`]'s own rule, that a pick which cannot be
/// honoured falls to a *default* rather than to whatever happens to sit nearest
/// it in the list. Only where none of the three is offered does the shape of
/// the ladder decide, and then it is the **top** rung: the app default is
/// already near the top, so a ladder missing it is a short one, and the top of
/// a short ladder is closer to what was asked than its floor.
export function usableEffort(
  model: Model,
  remembered: Effort | null,
  fallback: Effort,
): Effort | null {
  if (model.efforts.length === 0) return null;
  for (const wanted of [remembered, model.defaultEffort, fallback]) {
    if (wanted && model.efforts.includes(wanted)) return wanted;
  }
  return model.efforts[model.efforts.length - 1];
}

/// The agents in the order the picker draws them, which is also the order ⌘⇧A
/// steps through. One list: a chord visiting a harness the row cannot show, or
/// skipping one it can, reads as the chord being broken.
export const HARNESS_ORDER: Harness[] = ["claude_code", "codex", "pi", "fx"];

/// Where ⌘⇧A lands from `current`, wrapping. An unknown current steps onto the
/// first, the same place the picker parks its thumb.
export function nextHarness(current: Harness): Harness {
  const i = HARNESS_ORDER.indexOf(current);
  return HARNESS_ORDER[(i + 1) % HARNESS_ORDER.length];
}
