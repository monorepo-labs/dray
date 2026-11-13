import { pool } from "@/lib/db";
import { hashSecret, newSecret } from "@/lib/link";

function refuse(error: string, status = 400) {
  return Response.json({ error }, { status });
}

/// A server polls with its device code. Pending until someone approves at
/// /link; then it is handed its own credential, once, and the server row is
/// made, or moved where it already existed. RFC 8628's error names.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { deviceCode?: unknown } | null;
  if (typeof body?.deviceCode !== "string") return refuse("invalid_request");

  const db = await pool.connect();
  try {
    await db.query("begin");
    // `for update` so two polls racing can't both claim one approval.
    const { rows } = await db.query<{
      id: string;
      name: string;
      serverId: string | null;
      serverTokenHash: string | null;
      organizationId: string | null;
      approvedBy: string | null;
      denied: boolean;
      expired: boolean;
    }>(
      `select id, name, "serverId", "serverTokenHash", "organizationId", "approvedBy", denied, "expiresAt" < now() as expired
         from server_link where "deviceCodeHash" = $1 for update`,
      [hashSecret(body.deviceCode)],
    );
    const link = rows[0];
    if (!link) return await done(db, refuse("expired_token"));
    if (link.denied) {
      await db.query(`delete from server_link where id = $1`, [link.id]);
      return await done(db, refuse("access_denied"));
    }
    // Before the approved branch: a code changes nothing past its life,
    // approved or not.
    if (link.expired) {
      await db.query(`delete from server_link where id = $1`, [link.id]);
      return await done(db, refuse("expired_token"));
    }
    if (!link.organizationId || !link.approvedBy) return await done(db, refuse("authorization_pending"));

    const token = newSecret("drs_");
    const held = link.serverId
      ? (
          await db.query<{ organizationId: string; tokenHash: string | null }>(
            `select "organizationId", "tokenHash" from server where id = $1 for update`,
            [link.serverId],
          )
        ).rows[0]
      : undefined;
    // Read under the row lock: another code's claim may have replaced the
    // credential this code was made with, and then this one is stale.
    if (held && held.tokenHash !== link.serverTokenHash) {
      await db.query(`delete from server_link where id = $1`, [link.id]);
      return await done(db, refuse("expired_token"));
    }
    let serverId: string;
    if (held) {
      serverId = link.serverId!;
      const moved = held.organizationId !== link.organizationId;
      // A move takes the box's name, since the new org never named it; a
      // relink in place keeps whatever the org renamed it to.
      await db.query(
        `update server set "organizationId" = $2, "tokenHash" = $3, "linkedBy" = $4, "linkedAt" = now()
           ${moved ? ", name = $5" : ""} where id = $1`,
        [serverId, link.organizationId, hashSecret(token), link.approvedBy, ...(moved ? [link.name] : [])],
      );
      // The old org loses access with the server; a relink in place keeps
      // everyone already on the list.
      if (moved) await db.query(`delete from server_access where "serverId" = $1`, [serverId]);
    } else {
      serverId = crypto.randomUUID();
      await db.query(
        `insert into server (id, "organizationId", name, "linkedBy", "linkedAt", "tokenHash")
         values ($1, $2, $3, $4, now(), $5)`,
        [serverId, link.organizationId, link.name, link.approvedBy, hashSecret(token)],
      );
    }
    await db.query(
      `insert into server_access (id, "serverId", "userId") values ($1, $2, $3)
       on conflict ("serverId", "userId") do nothing`,
      [crypto.randomUUID(), serverId, link.approvedBy],
    );
    await db.query(`delete from server_link where id = $1`, [link.id]);
    const answer = await db.query<{ name: string; orgId: string; orgName: string; orgSlug: string }>(
      `select s.name, o.id as "orgId", o.name as "orgName", o.slug as "orgSlug"
         from server s join organization o on o.id = s."organizationId" where s.id = $1`,
      [serverId],
    );
    await db.query("commit");
    const row = answer.rows[0];
    return Response.json({
      token,
      server: { id: serverId, name: row.name },
      org: { id: row.orgId, name: row.orgName, slug: row.orgSlug },
    });
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

/// Commits what the read changed — an expired or denied link's deletion —
/// and answers.
async function done(db: { query: (sql: string) => Promise<unknown> }, answer: Response) {
  await db.query("commit");
  return answer;
}
