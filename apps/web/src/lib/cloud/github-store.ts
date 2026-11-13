import { pool } from "@/lib/db";

import { GitHubError, refreshUserToken, revokeGrant, type UserToken } from "./github-app";
import { open, seal } from "./vault";

/// A user's GitHub link, as `github_account` holds it (#1013).

export type GitHubAccount = { githubId: number; login: string; access: string };

/// The user's GitHub link is missing or dead, worded for the task's error line.
export class NotConnected extends Error {}

const bound = (userId: string, what: string) => `github:${what}:${userId}`;

/// Saves a fresh link, replacing any older one.
export async function saveAccount(userId: string, who: { id: number; login: string }, token: UserToken) {
  await pool.query(
    `insert into github_account (id, "userId", "githubId", login, "accessToken", "accessExpiresAt",
       "refreshToken", "refreshExpiresAt", "connectedAt")
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict ("userId") do update set "githubId" = $3, login = $4, "accessToken" = $5,
       "accessExpiresAt" = $6, "refreshToken" = $7, "refreshExpiresAt" = $8, "connectedAt" = now()`,
    [
      crypto.randomUUID(),
      userId,
      who.id,
      who.login,
      seal(token.access, bound(userId, "access")),
      token.accessExpiresAt,
      seal(token.refresh, bound(userId, "refresh")),
      token.refreshExpiresAt,
    ],
  );
}

/// Forgets the link and ends the grant on GitHub's side. Every machine's next
/// mint is refused from here on.
export async function deleteAccount(userId: string) {
  const { rows } = await pool.query<{ accessToken: string }>(
    `delete from github_account where "userId" = $1 returning "accessToken"`,
    [userId],
  );
  if (rows[0]) {
    const access = (() => {
      try {
        return open(rows[0].accessToken, bound(userId, "access"));
      } catch {
        return null;
      }
    })();
    if (access) await revokeGrant(access);
  }
}

export async function connected(userId: string): Promise<{ login: string } | null> {
  const { rows } = await pool.query<{ login: string }>(`select login from github_account where "userId" = $1`, [userId]);
  return rows[0] ?? null;
}

/// The user's GitHub token, refreshed first where it is within five minutes of
/// expiring. The refresh runs under the row's lock: GitHub's refresh tokens
/// are single-use, so two machines refreshing at once would lose the link.
export async function account(userId: string): Promise<GitHubAccount> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const { rows } = await db.query<{
      githubId: number;
      login: string;
      accessToken: string;
      refreshToken: string;
      stale: boolean;
      dead: boolean;
    }>(
      `select "githubId", login, "accessToken", "refreshToken",
              "accessExpiresAt" < now() + interval '5 minutes' as stale,
              "refreshExpiresAt" < now() as dead
         from github_account where "userId" = $1 for update`,
      [userId],
    );
    const row = rows[0];
    if (!row) throw new NotConnected("Connect GitHub on drayhq.com to run tasks on Cloud.");
    const who = { githubId: Number(row.githubId), login: row.login };
    if (!row.stale) {
      await db.query("commit");
      return { ...who, access: open(row.accessToken, bound(userId, "access")) };
    }
    if (row.dead) throw new NotConnected("Your GitHub link expired. Reconnect GitHub on drayhq.com.");
    let token: UserToken;
    try {
      token = await refreshUserToken(open(row.refreshToken, bound(userId, "refresh")));
    } catch (e) {
      if (e instanceof GitHubError && e.status === 401) {
        throw new NotConnected("GitHub no longer accepts your Dray link. Reconnect GitHub on drayhq.com.");
      }
      throw e;
    }
    await db.query(
      `update github_account set "accessToken" = $2, "accessExpiresAt" = $3, "refreshToken" = $4,
         "refreshExpiresAt" = $5 where "userId" = $1`,
      [
        userId,
        seal(token.access, bound(userId, "access")),
        token.accessExpiresAt,
        seal(token.refresh, bound(userId, "refresh")),
        token.refreshExpiresAt,
      ],
    );
    await db.query("commit");
    return { ...who, access: token.access };
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}
