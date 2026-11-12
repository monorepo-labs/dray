"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { managesServers } from "@/lib/session";

/// The org holding `serverId`, refused unless the reader may manage its
/// servers. A server in an org they aren't in reads as missing. Writes name
/// the org as well as the id, since a link can move the server between this
/// check and the write.
async function authorize(serverId: string): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Sign in again.");
  const { rows } = await pool.query<{ role: string; organizationId: string }>(
    `select m.role, s."organizationId" from server s
       join member m on m."organizationId" = s."organizationId" and m."userId" = $2
      where s.id = $1`,
    [serverId, session.user.id],
  );
  if (!rows[0]) throw new Error("That server is gone.");
  if (!managesServers(rows[0].role)) throw new Error("Only owners and admins can change servers.");
  return rows[0].organizationId;
}

/// Renames a server as the org sees it.
export async function renameServer(serverId: string, name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return "A server needs a name.";
  let orgId: string;
  try {
    orgId = await authorize(serverId);
  } catch (e) {
    return (e as Error).message;
  }
  await pool.query(`update server set name = $1 where id = $2 and "organizationId" = $3`, [
    trimmed.slice(0, 80),
    serverId,
    orgId,
  ]);
  revalidatePath("/app/[slug]/servers", "page");
  return null;
}

/// Unlinks a server from its org, taking its allow list with it.
export async function unlinkServer(serverId: string): Promise<string | null> {
  let orgId: string;
  try {
    orgId = await authorize(serverId);
  } catch (e) {
    return (e as Error).message;
  }
  await pool.query(`delete from server where id = $1 and "organizationId" = $2`, [serverId, orgId]);
  revalidatePath("/app/[slug]/servers", "page");
  return null;
}
