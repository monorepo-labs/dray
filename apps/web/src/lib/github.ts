import { REPO, STARS_FALLBACK } from "@/lib/links";

/// The repo's star count, read at render and cached for an hour.
///
/// Unauthenticated: the API allows 60 calls an hour per IP and ISR makes it
/// one, so a token would buy nothing. Any failure — rate limit, outage, the
/// API changing shape — falls back to the hand-kept number rather than a
/// missing count, because a nav link that sometimes shows a number and
/// sometimes doesn't reads as broken.
export async function fetchStars(): Promise<number> {
  const slug = new URL(REPO).pathname.slice(1);
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return STARS_FALLBACK;
    const data: unknown = await res.json();
    const n =
      typeof data === "object" && data !== null
        ? (data as { stargazers_count?: unknown }).stargazers_count
        : undefined;
    return typeof n === "number" ? n : STARS_FALLBACK;
  } catch {
    return STARS_FALLBACK;
  }
}

/// `1234` → `1.2k`. Past a thousand the exact figure changes hourly and
/// nobody reads the last two digits anyway.
export function formatStars(n: number): string {
  return n < 1000
    ? String(n)
    : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}
