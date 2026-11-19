import { createHash } from "node:crypto";

import { pool } from "./db";
import { hashSecret, newSecret } from "./link";

/// How long the one-time code handed back to the app lives.
const CODE_LIFE_SECS = 5 * 60;

/// What the app sends to start a sign-in, read off `/api/app/authorize`.
export type AppAuthRequest = {
  provider: "github" | "google" | "email";
  state: string;
  challenge: string;
  redirect: string;
  name: string;
};

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/// The request's fields, or null where any is missing or wrong. The redirect
/// must be the app's own server on this machine: anything else would hand a
/// stranger's address the code.
export function readAppAuth(params: URLSearchParams): AppAuthRequest | null {
  const provider = params.get("provider");
  const state = params.get("state") ?? "";
  const challenge = params.get("challenge") ?? "";
  const redirect = params.get("redirect") ?? "";
  const name = (params.get("name") ?? "").trim().slice(0, 80) || "This machine";
  if (provider !== "github" && provider !== "google" && provider !== "email") return null;
  if (!TOKEN.test(state) || !TOKEN.test(challenge)) return null;
  if (!isLoopback(redirect)) return null;
  return { provider, state, challenge, redirect, name };
}

function isLoopback(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "http:" &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
      u.pathname === "/auth/callback" &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}

/// The URL that sends the browser back to the app with `params`.
export function backToApp(req: AppAuthRequest, params: Record<string, string>): string {
  const u = new URL(req.redirect);
  u.searchParams.set("state", req.state);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/// Mints the one-time code the app trades for its credentials. Kept in Better
/// Auth's own `verification` table, keyed by the code's hash, so a leaked
/// database row can't be replayed.
export async function mintAppCode(userId: string, req: AppAuthRequest): Promise<string> {
  const code = newSecret("drc_");
  await pool.query(
    `insert into verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
     values ($1, $2, $3, now() + make_interval(secs => $4), now(), now())`,
    [
      crypto.randomUUID(),
      `app-auth:${hashSecret(code)}`,
      JSON.stringify({ userId, challenge: req.challenge, redirect: req.redirect, name: req.name }),
      CODE_LIFE_SECS,
    ],
  );
  return code;
}

/// What a code was minted for, once: the row goes whatever the answer, and a
/// code that is late or whose verifier doesn't match the challenge is refused.
export async function claimAppCode(
  code: string,
  verifier: string,
): Promise<{ userId: string; redirect: string; name: string } | null> {
  const { rows } = await pool.query<{ value: string; live: boolean }>(
    `delete from verification where identifier = $1 returning value, "expiresAt" > now() as live`,
    [`app-auth:${hashSecret(code)}`],
  );
  const row = rows[0];
  if (!row?.live) return null;
  const held = JSON.parse(row.value) as { userId: string; challenge: string; redirect: string; name: string };
  const proof = createHash("sha256").update(verifier).digest("base64url");
  return proof === held.challenge ? held : null;
}
