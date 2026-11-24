import { createHash } from "node:crypto";

import { pool } from "./db";

/// Counts one call against `what` in a fixed window and answers whether it is
/// over `max`. Postgres, since a serverless instance's memory is not shared.
export async function overLimit(what: string, max: number, windowSecs: number): Promise<boolean> {
  const id = createHash("sha256").update(`${windowSecs}:${what}`).digest("hex");
  const now = Math.floor(Date.now() / 1000);
  const start = now - (now % windowSecs);
  const { rows } = await pool.query<{ count: number }>(
    `insert into push_rate (id, "windowStart", count) values ($1, $2, 1)
     on conflict (id) do update set
       count = case when push_rate."windowStart" = excluded."windowStart" then push_rate.count + 1 else 1 end,
       "windowStart" = excluded."windowStart"
     returning count`,
    [id, start],
  );
  if (Math.random() < 0.01) await pool.query(`delete from push_rate where "windowStart" < $1`, [now - 86400]);
  return rows[0].count > max;
}

/// The caller's address as Vercel's edge reports it.
export function callerOf(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
