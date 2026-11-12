import { pool } from "@/lib/db";
import { isTaken } from "@/lib/auth";
import {
  LINK_LIFE_SECS,
  POLL_SECS,
  hashSecret,
  newSecret,
  newUserCode,
  serverForToken,
  showCode,
} from "@/lib/link";

/// Open to anyone, so what it may store is capped. Far above any real use:
/// a code lives ten minutes.
const MAX_PENDING = 500;

/// A server asks to be linked: the device-code flow's first step (RFC 8628's
/// shape, camelCased). It sends its name and, if it holds one, its current
/// credential, so approving moves that row rather than making a second.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { name?: unknown; token?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) return Response.json({ error: "invalid_request", error_description: "A server needs a name." }, { status: 400 });
  const current = typeof body?.token === "string" ? await serverForToken(body.token) : null;

  await pool.query(`delete from server_link where "expiresAt" < now() - interval '1 hour'`);
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from server_link where "expiresAt" > now()`,
  );
  if (rows[0].n >= MAX_PENDING)
    return Response.json({ error: "slow_down", error_description: "Too many links waiting. Try again in a few minutes." }, { status: 503 });

  const deviceCode = newSecret("drl_");
  for (let tries = 0; tries < 5; tries++) {
    const userCode = newUserCode();
    try {
      await pool.query(
        `insert into server_link (id, "deviceCodeHash", "userCode", name, "serverId", "expiresAt", denied)
         values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), false)`,
        [crypto.randomUUID(), hashSecret(deviceCode), userCode, name, current?.id ?? null, LINK_LIFE_SECS],
      );
    } catch (e) {
      if (isTaken(e)) continue;
      throw e;
    }
    const origin = new URL(req.url).origin;
    return Response.json({
      deviceCode,
      userCode: showCode(userCode),
      verificationUri: `${origin}/link`,
      verificationUriComplete: `${origin}/link?code=${showCode(userCode)}`,
      expiresIn: LINK_LIFE_SECS,
      interval: POLL_SECS,
    });
  }
  return Response.json({ error: "server_error" }, { status: 500 });
}
