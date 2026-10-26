import { readLocalStorage } from "@/hooks/useLocalStorage";
import { DEFAULT_MODEL_FOR } from "@/lib/model";
import type { Harness, Model, ModelId } from "@/types/events";

/// Where the reader's shortlist lives.
///
/// Local storage rather than the session index, because a star is a fact about
/// the reader and not about any session: it has to be true in the composer
/// before a session exists, and it must not travel with a session handed to
/// somebody else.
///
/// **Keyed by harness**, because ids repeat across them — the grok harness and
/// fx's grok provider both serve `grok-4.6` — and one flat list let starring a
/// model in one picker change the other, and made one's seeding skip the
/// other's as "already set up".
export const STARRED_MODELS_KEY = "ade.starredModelsByHarness";

/// The flat list pi and fx shared before stars were keyed. Read as their stars
/// until each writes its own entry, so nobody's shortlist resets on upgrade.
const LEGACY_STARS_KEY = "ade.starredModels";

export type StarsByHarness = Partial<Record<Harness, ModelId[]>>;

/// One harness's stars out of the keyed map.
export function starsFor(map: StarsByHarness, harness: Harness): ModelId[] {
  const own = map[harness];
  if (own) return own;
  return harness === "pi" || harness === "fx"
    ? readLocalStorage<ModelId[]>(LEGACY_STARS_KEY, [])
    : [];
}

/// Which harnesses and fx providers have had their defaults seeded, so it
/// happens once each. The storage key predates the other harnesses joining.
export const STARS_SEEDED_KEY = "ade.fxStarsSeeded";

/// The marker a seed is recorded under. fx seeds per provider, the rest per
/// harness — prefixed, since fx has providers named `codex` and `grok` too.
export function seedKey(harness: Harness, provider: string): string {
  return harness === "fx" ? provider : `harness:${harness}`;
}

/// What fx's picker opens on, per provider, before the reader has starred
/// anything there.
///
/// A shortlisted harness with no stars draws an empty menu, and "No models
/// shortlisted yet" over a picker that cannot pick is a feature asking to be
/// set up before it works at all. These are *seeded as real stars* the first
/// time a provider's list lands rather than drawn as a special case, so the
/// reader unstars, adds to and reorders them like any others — the list stops
/// being ours the moment they touch it.
const FX_DEFAULT_STARS: Record<string, string[]> = {
  gateway: ["gpt-5.6-sol", "grok-4.6", "claude-opus-5"],
  codex: ["gpt-6-astra", "gpt-5.6-sol"],
  grok: ["grok-4.6"],
};

/// The default stars for a harness, narrowed to models it actually serves.
///
/// Claude Code, Codex and grok star every row not marked `secondary` — the
/// short list Dray names. pi seeds nothing: its list is whatever the reader's
/// providers serve, and Dray has no opinion on which of them to work with.
///
/// A needle matches a whole id or its last segment: the gateway names a model
/// `openai/gpt-5.6-sol` where fx's own providers name the same thing
/// `gpt-5.6-sol`, so one needle answers for both. A needle naming nothing in
/// the list — fx renamed it, or the account cannot reach it — seeds nothing,
/// which is the same state as before this existed.
export function defaultStars(harness: Harness, provider: string, models: Model[]): ModelId[] {
  if (harness === "pi") return [];
  if (harness !== "fx") return models.filter((m) => !m.secondary).map((m) => m.id);
  const needles = FX_DEFAULT_STARS[provider] ?? [];
  return models
    .filter((m) => needles.some((n) => m.id === n || m.id.endsWith(`/${n}`)))
    .map((m) => m.id);
}

/// Every row each seed key's list has ever shown, so a row that appears later
/// can be told apart from one the reader saw and left unstarred.
export const OFFERED_MODELS_KEY = "ade.offeredModels";

/// What a list landing owes the shortlist: the stars to add, and the offered
/// record to keep for next time.
///
/// Seeding once was right for the reader's choices and wrong for the vendor's:
/// a model published after the seed never reached an already-seeded shortlist,
/// so Codex's new default sat unstarred, missing from the picker and from ⇧⇥.
/// Now a row the default seed would star is starred **the first time it is
/// offered**, and only then — unstarring it again sticks.
///
/// The record starts with the build that writes it, so a key seeded before
/// then has no history to compare with. That one landing stars the harness's
/// default model alone: every other row on it may be one the reader turned
/// down, where the default is the row this issue was about.
export function starsToAdd(
  harness: Harness,
  provider: string,
  models: Model[],
  starred: ModelId[],
  offered: ModelId[] | undefined,
  seeded: boolean,
): { add: ModelId[]; offered: ModelId[] } {
  const seen = new Set(offered ?? []);
  const record = [...(offered ?? []), ...models.map((m) => m.id).filter((id) => !seen.has(id))];

  let add: ModelId[];
  if (!seeded) {
    // A reader who already starred something here predates the seed marker;
    // their list is the answer and ours would arrive as rows nobody asked for.
    add = models.some((m) => starred.includes(m.id))
      ? []
      : defaultStars(harness, provider, models);
  } else if (!offered) {
    const fallback = DEFAULT_MODEL_FOR[harness];
    add = models.some((m) => m.id === fallback && !m.secondary) ? [fallback] : [];
  } else {
    add = defaultStars(harness, provider, models).filter((id) => !seen.has(id));
  }

  return { add: add.filter((id) => !starred.includes(id)), offered: record };
}

/// The models the composer's picker draws.
///
/// Starred ones in the list's own order, plus the session's **current** model
/// whether or not it is starred. That second half is not a convenience: a
/// session already running on a model reads its own name off this list, and
/// unstarring it mid-session would otherwise leave the trigger naming a model
/// the menu says nothing about.
///
/// A star for a model no provider currently serves is kept in storage and drawn
/// nowhere — logging a provider out is a state that ends, and dropping the star
/// would make the reader set it up again on the way back.
export function shortlist(
  models: Model[],
  starred: ModelId[],
  current: ModelId,
): Model[] {
  const stars = new Set(starred);
  return models.filter((m) => stars.has(m.id) || m.id === current);
}

/// [`shortlist`] for Shift+Tab, which cycles exactly what the picker draws — a
/// press landing on a model the menu never offered is the bug sharing prevents.
///
/// The stars are read at the moment of the press rather than held: a second
/// `useLocalStorage` copy in `App` would drift from the picker's the first time
/// the library dialog wrote one.
export function cycledModels(models: Model[], harness: Harness, current: ModelId): Model[] {
  const map = readLocalStorage<StarsByHarness>(STARRED_MODELS_KEY, {});
  return shortlist(models, starsFor(map, harness), current);
}

/// The models grouped under their provider, in the order the list arrived in.
///
/// Insertion order rather than alphabetical: pi answers provider by provider,
/// so its own order already groups them, and sorting would move a heading the
/// reader had just found.
export function byProvider(models: Model[]): { provider: string; models: Model[] }[] {
  const groups: { provider: string; models: Model[] }[] = [];

  for (const model of models) {
    const group = groups.find((g) => g.provider === model.provider);
    if (group) group.models.push(model);
    else groups.push({ provider: model.provider, models: [model] });
  }

  return groups;
}

export function toggleStar(starred: ModelId[], id: ModelId): ModelId[] {
  return starred.includes(id) ? starred.filter((s) => s !== id) : [...starred, id];
}

/// Case-insensitive substring, over everything on the row a reader can see plus
/// the id underneath it.
///
/// The id is searched because it is what `dray new --model` takes and what an
/// error names, so somebody arriving with one in hand can find its row.
export function matchesQuery(model: Model, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  return (
    model.label.toLowerCase().includes(q) ||
    model.provider.toLowerCase().includes(q) ||
    model.id.toLowerCase().includes(q)
  );
}
