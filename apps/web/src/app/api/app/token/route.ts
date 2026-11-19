import { claimAppCode } from "@/lib/app-auth";
import { pool } from "@/lib/db";
import { type AppUser, hashSecret, newSecret, userForAppToken } from "@/lib/link";

function refuse(error: string, status = 400) {
  return Response.json({ error }, { status });
}

/// The app's server trades the code `/api/app/authorize` sent back, with the
/// PKCE verifier only it holds, for two credentials: the app's, saying who
/// signed in, and the machine's own, linking it to that account's org. A
/// machine already linked sends its credential, so its row is re-keyed in
/// place rather than doubled. Answers in `/api/link/token`'s shape.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { code?: unknown; verifier?: unknown; held?: unknown } | null;
  if (typeof body?.code !== "string" || typeof body.verifier !== "string") return refuse("invalid_request");
  const claim = await claimAppCode(body.code, body.verifier);
  if (!claim) return refuse("invalid_grant");

  const db = await pool.connect();
  try {
    await db.query("begin");
    const { rows: orgs } = await db.query<{ id: string }>(
      `select m."organizationId" as id from member m
        where m."userId" = $1 and (m.role like '%owner%' or m.role like '%admin%')
        order by m."createdAt" limit 1`,
      [claim.userId],
    );
    // Every account gets an org at sign-up, so none here is a fault.
    if (!orgs[0]) {
      await db.query("rollback");
      return refuse("no_org", 409);
    }
    const token = newSecret("drs_");
    const held =
      typeof body.held === "string"
        ? (
            await db.query<{ id: string; organizationId: string; manages: boolean }>(
              `select s.id, s."organizationId",
                      exists (select 1 from member m where m."organizationId" = s."organizationId"
                                and m."userId" = $2 and (m.role like '%owner%' or m.role like '%admin%')) as manages
                 from server s where s."tokenHash" = $1 for update`,
              [hashSecret(body.held), claim.userId],
            )
          ).rows[0]
        : undefined;
    let serverId: string;
    if (held?.manages) {
      // Already linked to an org this account runs: keep it there.
      serverId = held.id;
      await db.query(`update server set "tokenHash" = $2, "linkedBy" = $3, "linkedAt" = now() where id = $1`, [
        serverId,
        hashSecret(token),
        claim.userId,
      ]);
    } else if (held) {
      // Linked somewhere this account doesn't run: move it, and the old org
      // loses access with it, as `/api/link/token` does.
      serverId = held.id;
      await db.query(
        `update server set "organizationId" = $2, "tokenHash" = $3, "linkedBy" = $4, "linkedAt" = now(), name = $5
          where id = $1`,
        [serverId, orgs[0].id, hashSecret(token), claim.userId, claim.name],
      );
      await db.query(`delete from server_access where "serverId" = $1`, [serverId]);
    } else {
      serverId = crypto.randomUUID();
      await db.query(
        `insert into server (id, "organizationId", name, "linkedBy", "linkedAt", "tokenHash")
         values ($1, $2, $3, $4, now(), $5)`,
        [serverId, orgs[0].id, claim.name, claim.userId, hashSecret(token)],
      );
    }
    await db.query(
      `insert into server_access (id, "serverId", "userId") values ($1, $2, $3)
       on conflict ("serverId", "userId") do nothing`,
      [crypto.randomUUID(), serverId, claim.userId],
    );
    const appToken = newSecret("dra_");
    await db.query(`insert into app_session (id, "userId", "tokenHash", name) values ($1, $2, $3, $4)`, [
      crypto.randomUUID(),
      claim.userId,
      hashSecret(appToken),
      claim.name,
    ]);
    const user: AppUser | null = await userForAppToken(appToken, db);
    const { rows } = await db.query<{ name: string; orgId: string; orgName: string; orgSlug: string }>(
      `select s.name, o.id as "orgId", o.name as "orgName", o.slug as "orgSlug"
         from server s join organization o on o.id = s."organizationId" where s.id = $1`,
      [serverId],
    );
    await db.query("commit");
    const row = rows[0];
    return Response.json({
      token,
      server: { id: serverId, name: row.name },
      org: { id: row.orgId, name: row.orgName, slug: row.orgSlug },
      account: { token: appToken, user },
    });
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}
