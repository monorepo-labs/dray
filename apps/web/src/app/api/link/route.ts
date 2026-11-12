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
/// `signIn` is the app's own sign-in: approving also signs the approver in.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { name?: unknown; token?: unknown; signIn?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) return Response.json({ error: "invalid_request", error_description: "A server needs a name." }, { status: 400 });
  const token = typeof body?.token === "string" ? body.token : null;
  const signIn = body?.signIn === true;
  const current = token ? await serverForToken(token) : null;

  await pool.query(`delete from server_link where "expiresAt" < now() - interval '1 hour'`);
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from server_link where "expiresAt" > now()`,
  );
  if (rows[0].n >= MAX_PENDING)
    return Response.json({ error: "slow_down", error_description: "Too many links waiting. Try again in a few minutes." }, { status: 503 });

  // One live code per server: a new one replaces any it had waiting.
  if (current) await pool.query(`delete from server_link where "serverId" = $1`, [current.id]);

  const deviceCode = newSecret("drl_");
  for (let tries = 0; tries < 5; tries++) {
    const userCode = newUserCode();
    try {
      await pool.query(
        `insert into server_link (id, "deviceCodeHash", "userCode", name, "serverId", "serverTokenHash", "expiresAt", denied, "signIn")
         values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), false, $8)`,
        [
          crypto.randomUUID(),
          hashSecret(deviceCode),
          userCode,
          name,
          current?.id ?? null,
          current && token ? hashSecret(token) : null,
          LINK_LIFE_SECS,
          signIn,
        ],
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
