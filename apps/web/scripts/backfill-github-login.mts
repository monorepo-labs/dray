/// One-off: saves `user.githubLogin` for accounts made before the site kept
/// it at GitHub sign-up (#1504), so their bots can tell a name that is only
/// the login from one typed. Run after `pnpm db:migrate`, against the same
/// DATABASE_URL:
///
///   pnpm db:backfill-github-login --dry-run   # counts only, writes nothing
///   pnpm db:backfill-github-login
///
/// GITHUB_TOKEN is optional and lifts GitHub's limit from 60 lookups an hour
/// to 5000. Safe to run again: it only reads users with a linked GitHub
/// account and no saved login, so a rerun picks up where a limit stopped it.
/// Prints counts alone, never a name, email or login.
import pg from "pg";

const dryRun = process.argv.includes("--dry-run");
const token = process.env.GITHUB_TOKEN;
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

/// Users still without a login, each with the numeric id of their oldest
/// linked GitHub account. Users without one never come back from this.
const { rows } = await pool.query<{ userId: string; githubId: string }>(
  `select distinct on (u.id) u.id as "userId", a."accountId" as "githubId"
     from "user" u join "account" a on a."userId" = u.id and a."providerId" = 'github'
    where u."githubLogin" is null
    order by u.id, a."createdAt"`,
);
console.log(`${rows.length} user(s) with GitHub and no saved login.`);
if (dryRun) {
  await pool.end();
  process.exit(0);
}

let saved = 0;
let gone = 0;
let failed = 0;
let stopped = false;
for (const { userId, githubId } of rows) {
  // GitHub answers ids alone, so anything else is a bad row, not a lookup.
  if (!/^\d+$/.test(githubId)) {
    failed++;
    continue;
  }
  const res = await fetch(`https://api.github.com/user/${githubId}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "dray-backfill",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });
  if (res.status === 404) {
    gone++;
    continue;
  }
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const when = reset ? ` Resets at ${new Date(reset * 1000).toISOString()}.` : "";
    console.error(`GitHub's rate limit stopped the run; run it again later.${when}`);
    stopped = true;
    break;
  }
  const login = res.ok ? ((await res.json()) as { login?: unknown }).login : undefined;
  if (typeof login !== "string" || !login) {
    failed++;
    continue;
  }
  // The null check again, so a sign-up that saved one meanwhile is left alone.
  const { rowCount } = await pool.query(
    `update "user" set "githubLogin" = $1 where id = $2 and "githubLogin" is null`,
    [login, userId],
  );
  saved += rowCount ?? 0;
}

console.log(`Saved ${saved}; ${gone} GitHub account(s) no longer exist; ${failed} lookup(s) failed.`);
await pool.end();
process.exit(stopped || failed ? 1 : 0);
