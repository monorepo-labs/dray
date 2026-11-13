import { pool } from "@/lib/db";
import { bearer, hashSecret, linkedAnswer, serverForToken } from "@/lib/link";

const UNLINKED = () => Response.json({ error: "invalid_token" }, { status: 401 });

/// Where a linked server stands: its row and its org. A 401 means it was
/// unlinked, here or on the Servers page, and should forget its credential.
export async function GET(req: Request) {
  const token = bearer(req);
  const row = token ? await serverForToken(token) : null;
  return row ? Response.json(linkedAnswer(row)) : UNLINKED();
}

/// `dray logout`: the server unlinks itself. Deleting the row takes the
/// credential and the allow list with it, as unlinking on the site does.
export async function DELETE(req: Request) {
  const token = bearer(req);
  if (!token) return UNLINKED();
  const { rowCount } = await pool.query(`delete from server where "tokenHash" = $1`, [hashSecret(token)]);
  return rowCount ? new Response(null, { status: 204 }) : UNLINKED();
}
