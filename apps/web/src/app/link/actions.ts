"use server";

import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { normalizeCode } from "@/lib/link";
import { managesServers } from "@/lib/session";

const GONE = "That code has expired or was already used. Run dray login again.";

async function userId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Sign in again.");
  return session.user.id;
}

/// Approves a waiting link into `orgId`. Nothing moves here: the server's
/// next poll claims the approval, makes or moves its row and takes its
/// credential, so an approval the server never collects leaves nothing behind.
export async function approveLink(
  code: string,
  orgId: string,
): Promise<{ error: string } | { org: { name: string; slug: string } }> {
  let user: string;
  try {
    user = await userId();
  } catch (e) {
    return { error: (e as Error).message };
  }
  const { rows } = await pool.query<{ role: string; name: string; slug: string }>(
    `select m.role, o.name, o.slug from member m join organization o on o.id = m."organizationId"
      where m."userId" = $1 and m."organizationId" = $2`,
    [user, orgId],
  );
  const org = rows[0];
  if (!org || !managesServers(org.role))
    return { error: "Only an org's owners and admins can link servers to it." };
  const { rowCount } = await pool.query(
    `update server_link set "organizationId" = $1, "approvedBy" = $2
      where "userCode" = $3 and "organizationId" is null and not denied and "expiresAt" > now()`,
    [orgId, user, normalizeCode(code)],
  );
  return rowCount ? { org: { name: org.name, slug: org.slug } } : { error: GONE };
}

/// Refuses a waiting link, so the server's next poll stops at once rather
/// than waiting out the code.
export async function denyLink(code: string): Promise<string | null> {
  try {
    await userId();
  } catch (e) {
    return (e as Error).message;
  }
  const { rowCount } = await pool.query(
    `update server_link set denied = true
      where "userCode" = $1 and "organizationId" is null and not denied and "expiresAt" > now()`,
    [normalizeCode(code)],
  );
  return rowCount ? null : GONE;
}
