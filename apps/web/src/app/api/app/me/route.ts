import { pool } from "@/lib/db";
import { bearer, hashSecret, userForAppToken } from "@/lib/link";

const SIGNED_OUT = () => Response.json({ error: "invalid_token" }, { status: 401 });

/// Who the desktop app is signed in as. A 401 means the credential was
/// revoked or its account deleted, and the app should forget it.
export async function GET(req: Request) {
  const token = bearer(req);
  const user = token ? await userForAppToken(token) : null;
  return user ? Response.json({ user }) : SIGNED_OUT();
}

/// The app's Sign out: revokes its credential. The machine stays linked.
export async function DELETE(req: Request) {
  const token = bearer(req);
  if (!token) return SIGNED_OUT();
  const { rowCount } = await pool.query(`delete from app_session where "tokenHash" = $1`, [hashSecret(token)]);
  return rowCount ? new Response(null, { status: 204 }) : SIGNED_OUT();
}
