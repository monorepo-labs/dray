import { Pool } from "pg";

const held = globalThis as { drayPool?: Pool };

/// The one Postgres pool per process. Held on `globalThis` because dev reloads
/// this module on every edit, and a pool per reload leaks connections to Railway.
export const pool = (held.drayPool ??= new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
}));
