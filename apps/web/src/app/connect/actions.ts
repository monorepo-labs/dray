"use server";

import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { ASSERTION_LIFE_SECS, mayConnect, withQuery } from "@/lib/mcp";

const GONE = "This sign-in has expired. Start again from your assistant.";
const REFUSED = "This account can't connect an assistant to that server.";

/// Allows a waiting sign-in: signs an assertion for the server and answers
/// where to send the browser. The row is taken in the same statement, so a
/// sign-in is answered once.
export async function allowConnect(
  id: string,
  readOnly: boolean,
): Promise<{ url: string } | { error: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in again." };
  const { rows } = await pool.query<{ serverId: string }>(
    `select "serverId" from mcp_sign_in where id = $1 and "expiresAt" > now()`,
    [id],
  );
  if (!rows[0]) return { error: GONE };
  if (!(await mayConnect(rows[0].serverId, session.user.id))) return { error: REFUSED };
  const { rows: taken } = await pool.query<{ serverId: string; returnUrl: string; state: string }>(
    `delete from mcp_sign_in where id = $1 and "expiresAt" > now() returning "serverId", "returnUrl", state`,
    [id],
  );
  const signIn = taken[0];
  if (!signIn) return { error: GONE };

  const now = Math.floor(Date.now() / 1000);
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        sub: session.user.id,
        // The server checks this is its own id, so an assertion made for one
        // server is no use at another.
        aud: signIn.serverId,
        nonce: signIn.state,
        access: readOnly ? "read" : "full",
        email: session.user.email,
        name: session.user.name,
        iat: now,
        exp: now + ASSERTION_LIFE_SECS,
      },
    },
  });
  return { url: withQuery(signIn.returnUrl, { assertion: token }) };
}

/// Cancels a waiting sign-in and answers where to send the browser, so the
/// assistant hears no rather than waiting out the code.
export async function cancelConnect(id: string): Promise<{ url: string } | { error: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in again." };
  const { rows } = await pool.query<{ returnUrl: string; state: string }>(
    `delete from mcp_sign_in where id = $1 and "expiresAt" > now() returning "returnUrl", state`,
    [id],
  );
  const signIn = rows[0];
  if (!signIn) return { error: GONE };
  return { url: withQuery(signIn.returnUrl, { error: "access_denied", state: signIn.state }) };
}
