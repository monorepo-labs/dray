import { pool } from "@/lib/db";
import { bearer, serverForToken } from "@/lib/link";
import { acceptableReturn, MAX_WAITING, SIGN_IN_LIFE_SECS } from "@/lib/mcp";

function refuse(error: string, status = 400) {
  return Response.json({ error }, { status });
}

/// A server pushes an assistant's sign-in here before sending the browser to
/// `/connect/<id>`. The server's credential is what vouches for `returnUrl`,
/// so the page never takes a return address from the browser.
export async function POST(req: Request) {
  const token = bearer(req);
  const server = token ? await serverForToken(token) : null;
  if (!server) return refuse("invalid_token", 401);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const text = (key: string, max: number) => {
    const value = body?.[key];
    return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
  };
  const returnUrl = text("returnUrl", 2048);
  const state = text("state", 256);
  const client = text("client", 80);
  const redirectHost = text("redirectHost", 256);
  if (!returnUrl || !state || !client || !redirectHost || !acceptableReturn(returnUrl))
    return refuse("invalid_request");

  await pool.query(`delete from mcp_sign_in where "expiresAt" < now()`);
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from mcp_sign_in where "serverId" = $1`,
    [server.id],
  );
  if (rows[0].n >= MAX_WAITING) return refuse("slow_down", 429);

  const id = crypto.randomUUID();
  await pool.query(
    `insert into mcp_sign_in (id, "serverId", "returnUrl", state, client, "redirectHost", "expiresAt")
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [id, server.id, returnUrl, state, client, redirectHost, SIGN_IN_LIFE_SECS],
  );
  return Response.json({ url: `${new URL(req.url).origin}/connect/${id}` });
}
