import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./ledger.ts";

/**
 * Embedded Postgres (WASM) for tests and local development. Pass a directory
 * to persist across runs, or nothing for an in-memory database.
 */
export async function openLocalDb(dataDir?: string): Promise<Db & { close(): Promise<void> }> {
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  return {
    query: (text, params) => pg.query(text, params),
    exec: (sql) => pg.exec(sql),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })),
    close: () => pg.close(),
  } as Db & { close(): Promise<void> };
}
