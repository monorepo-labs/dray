import { pool } from "./db";

/// How long a pushed sign-in waits for the reader, and how long the assertion
/// it ends in is good for. The assertion only has to survive one redirect.
export const SIGN_IN_LIFE_SECS = 10 * 60;
export const ASSERTION_LIFE_SECS = 2 * 60;
/// Sign-ins one server may have waiting at once, the oldest dropped to make
/// room for a new one.
export const MAX_WAITING = 50;

/// Whether `userId` may connect an assistant to `serverId`: on its allow list
/// and still a member of its org. Leaving an org leaves the allow-list row
/// behind on purpose, so the membership join is what makes it count.
export async function mayConnect(serverId: string, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `select 1 from server_access a
       join server s on s.id = a."serverId"
       join member m on m."organizationId" = s."organizationId" and m."userId" = a."userId"
      where a."serverId" = $1 and a."userId" = $2`,
    [serverId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/// Where a server may ask the browser to be sent back: its own address, which
/// is `https:` behind Remote access, or loopback `http:` for an assistant on
/// the same machine.
export function acceptableReturn(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/// `url` with `params` added to its query.
export function withQuery(url: string, params: Record<string, string>): string {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
}
