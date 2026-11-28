/// More saved secrets than this and the picker opens with a search field. The
/// iOS and Android pickers use the same number.
export const SECRET_SEARCH_AFTER = 6;

/// The saved names a search keeps, in their order. Every word must appear in
/// the name, case aside, and `_` counts as a space, so "github token" finds
/// GITHUB_TOKEN.
export function matchSecrets(names: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/[\s_]+/).filter(Boolean);
  if (words.length === 0) return [...names];
  return names.filter((n) => {
    const name = n.toLowerCase();
    return words.every((w) => name.includes(w));
  });
}
