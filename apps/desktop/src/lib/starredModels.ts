import { readLocalStorage } from "@/hooks/useLocalStorage";
import type { Harness, Model, ModelId } from "@/types/events";

/// Where the reader's shortlist lives.
///
/// Local storage rather than the session index, because a star is a fact about
/// the reader and not about any session: it has to be true in the composer
/// before a session exists, and it must not travel with a session handed to
/// somebody else.
export const STARRED_MODELS_KEY = "ade.starredModels";

/// Harnesses whose picker draws the shortlist rather than the whole list.
///
/// pi alone, and not as a preference. Its list is *discovered* — every model
/// every provider the reader has logged into serves — so it has no bound, and
/// a menu of everything is a menu nobody reads. Claude Code and Codex each ship
/// a handful of models Dray names itself, where a shortlist would be one more
/// thing to set up before the picker works at all.
const SHORTLISTED: Harness[] = ["pi"];

export function usesShortlist(harness: Harness): boolean {
  return SHORTLISTED.includes(harness);
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

/// The rows the picker draws at its top level, which is **also exactly what
/// Shift+Tab cycles**. One function because they are one list: the chord and
/// the menu disagreeing means a press lands on a model the menu never offered,
/// which is what it did on pi — the menu drew the reader's shortlist while the
/// chord walked every model every logged-in provider serves.
///
/// The two harnesses answer the same question differently and both are here:
/// pi bounds an unbounded discovered list by what the reader starred, where
/// Claude Code and Codex bound a written one by `secondary`.
export function topLevel(
  models: Model[],
  starred: ModelId[],
  harness: Harness,
  current: ModelId,
): Model[] {
  return usesShortlist(harness)
    ? shortlist(models, starred, current)
    : models.filter((m) => !m.secondary);
}

/// What the picker folds into "More models". Empty for a shortlisted harness,
/// whose own overflow is the library dialog rather than a submenu.
export function underMore(models: Model[], harness: Harness): Model[] {
  return usesShortlist(harness) ? [] : models.filter((m) => m.secondary);
}

/// [`topLevel`] for a caller with no `starred` state of its own.
///
/// The stars are read at the moment of the press rather than held, which is
/// the point: a second `useLocalStorage` copy in `App` would drift from the
/// picker's the first time the library dialog wrote one, and a chord reading a
/// stale shortlist is the bug this exists to fix, not a different one.
export function cycledModels(
  models: Model[],
  harness: Harness,
  current: ModelId,
): Model[] {
  return topLevel(models, readLocalStorage<ModelId[]>(STARRED_MODELS_KEY, []), harness, current);
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
