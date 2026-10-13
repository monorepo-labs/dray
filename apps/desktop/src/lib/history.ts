/// One page a session's browser visited, as `browser_history` answers it.
/// `last` is unix milliseconds. Kept per session, in the session's profile —
/// see cef/history.rs.
export type BrowserVisit = {
  url: string;
  title: string;
  favicon: string;
  visits: number;
  last: number;
};

/// The address without its scheme or `www.`, which is what a reader types.
export function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "");
}

/// The visits matching what is typed in the URL bar, best first. An address
/// starting with the text outranks one merely containing it, or a title
/// containing it; within a rank, the more visited and then the more recent
/// lead. The newest list is the input, so a stable sort keeps recency.
export function matchHistory(visits: BrowserVisit[], query: string, limit = 6): BrowserVisit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: { visit: BrowserVisit; rank: number }[] = [];
  for (const visit of visits) {
    const bare = bareUrl(visit.url).toLowerCase();
    const rank = bare.startsWith(q)
      ? 0
      : bare.includes(q) || visit.title.toLowerCase().includes(q)
        ? 1
        : -1;
    if (rank >= 0) ranked.push({ visit, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || b.visit.visits - a.visit.visits);
  return ranked.slice(0, limit).map((r) => r.visit);
}
