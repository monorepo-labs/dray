import { Pool } from "pg";

const held = globalThis as { drayPool?: Pool; drayLockPool?: Pool };

/// The one Postgres pool per process. Held on `globalThis` because dev reloads
/// this module on every edit, and a pool per reload leaks connections to Railway.
export const pool = (held.drayPool ??= new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
}));

/// Connections that only wait on and hold advisory locks. Kept apart from
/// `pool` so callers queued on a lock can never hold every connection the
/// lock's holder needs to finish and let go.
const lockPool = (held.drayLockPool ??= new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
}));

/// Runs `fn` while holding the transaction-scoped advisory lock named `key`,
/// so callers with the same key run one at a time across processes.
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const client = await lockPool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
    return await fn();
  } finally {
    // Ending the transaction is what lets the lock go; nothing was written.
    await client.query("rollback").catch(() => {});
    client.release();
  }
}
