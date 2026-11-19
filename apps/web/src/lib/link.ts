import { createHash, randomBytes, randomInt } from "node:crypto";

import { pool } from "./db";

/// How long a code waits for approval, and how often a server asks.
export const LINK_LIFE_SECS = 10 * 60;
export const POLL_SECS = 3;

/// Readable off a terminal and typed on a phone: no 0/O, 1/I/L, U. The same
/// alphabet the server's own MCP pairing codes use.
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/// What the database keeps of a secret a server holds.
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/// A long random secret, prefixed so a leaked one says what it is.
export function newSecret(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

/// Eight characters, stored without the dash.
export function newUserCode(): string {
  return Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

/// A typed code as stored: case, dashes and spaces dropped.
export function normalizeCode(typed: string): string {
  return typed.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

/// `ABCD-EFGH`, as the server prints it.
export function showCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/// The bearer token on a request from a linked server.
export function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

/// The server row a credential belongs to, with its org.
export async function serverForToken(token: string) {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    orgId: string;
    orgName: string;
    orgSlug: string;
  }>(
    `select s.id, s.name, o.id as "orgId", o.name as "orgName", o.slug as "orgSlug"
       from server s join organization o on o.id = s."organizationId"
      where s."tokenHash" = $1`,
    [hashSecret(token)],
  );
  return rows[0] ?? null;
}

/// Who an app is signed in as.
export type AppUser = { id: string; name: string; username: string | null; image: string | null };

/// The account an app credential belongs to. Takes the caller's client
/// where it reads inside a transaction that made the row.
export async function userForAppToken(
  token: string,
  db: { query: typeof pool.query } = pool,
): Promise<AppUser | null> {
  const { rows } = await db.query<AppUser>(
    `select u.id, u.name, u.username, u.image from app_session a join "user" u on u.id = a."userId"
      where a."tokenHash" = $1`,
    [hashSecret(token)],
  );
  return rows[0] ?? null;
}

/// What a server is told about where it is linked.
export function linkedAnswer(row: NonNullable<Awaited<ReturnType<typeof serverForToken>>>) {
  return {
    server: { id: row.id, name: row.name },
    org: { id: row.orgId, name: row.orgName, slug: row.orgSlug },
  };
}
