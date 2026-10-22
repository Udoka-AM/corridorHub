import pg from "pg";
import type { Db } from "./ledger.ts";

/**
 * A real Postgres server (node-postgres pool) behind the same `Db` surface as
 * PGlite, for production. `DATABASE_URL`-style connection string.
 */
export async function openPostgresDb(connectionString: string, opts: { max?: number } = {}): Promise<Db & { close(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  // Fail at startup, not on the first request.
  await pool.query("select 1");
  return {
    query: async <T>(text: string, params?: unknown[]) => ({ rows: (await pool.query(text, params)).rows as T[] }),
    exec: (sql: string) => pool.query(sql),
    async transaction<T>(fn: (tx: { query: Db["query"] }) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: async <R>(text: string, params?: unknown[]) => ({ rows: (await client.query(text, params)).rows as R[] }) });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  } as Db & { close(): Promise<void> };
}
