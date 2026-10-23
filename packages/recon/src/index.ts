import type { Observation } from "@corridor/core";
import type { Db, Ledger } from "@corridor/ledger";

/**
 * Reconciliation: joins what observers saw on each venue with what the ledger
 * booked. Stellar payment watchers, chain observers on the spokes and anchor
 * webhooks all feed the same matcher.
 */

export type MatchStatus =
  /** Booked, same amount. */
  | "matched"
  /** Booked, but the ledger amount differs from what the chain shows. */
  | "amount_mismatch"
  /** Carries a Corridor Reference but nothing in the books: our own movement went unrecorded. */
  | "unbooked"
  /** No Corridor Reference and not booked: an unidentified deposit to investigate. */
  | "unreferenced";

export interface ReconResult {
  observation: Observation;
  status: MatchStatus;
  entryId?: string;
  bookedAmount?: bigint;
}

export async function reconcile(ledger: Ledger, observations: Observation[]): Promise<ReconResult[]> {
  const results: ReconResult[] = [];
  for (const observation of observations) {
    const entryId = await ledger.findByExternal(observation.venue, observation.externalRef);
    if (!entryId) {
      results.push({ observation, status: observation.reference ? "unbooked" : "unreferenced" });
      continue;
    }
    // Compare against the entry's movement across Corridor's vaults, which is
    // the part of it that exists on a chain. The customer's hold and the peg
    // accounts are in the same asset now that the hub settles in USDC, and no
    // observer ever sees those.
    const bookedAmount = await ledger.entryVaultMovement(entryId, observation.asset);
    results.push({
      observation,
      entryId,
      bookedAmount,
      status: bookedAmount === observation.amount ? "matched" : "amount_mismatch",
    });
  }
  return results;
}

export function summarize(results: ReconResult[]): Record<MatchStatus, number> {
  const out: Record<MatchStatus, number> = { matched: 0, amount_mismatch: 0, unbooked: 0, unreferenced: 0 };
  for (const r of results) out[r.status]++;
  return out;
}

/** Observer block cursors, stored next to the ledger. */
export class PgCursorStore {
  private constructor(private readonly db: Db) {}

  static async open(db: Db): Promise<PgCursorStore> {
    await db.exec(`create table if not exists observer_cursors (name text primary key, block numeric(78,0) not null)`);
    return new PgCursorStore(db);
  }

  async get(name: string): Promise<bigint | undefined> {
    const { rows } = await this.db.query<{ block: string }>(`select block::text block from observer_cursors where name = $1`, [name]);
    return rows[0] ? BigInt(rows[0].block) : undefined;
  }

  async set(name: string, block: bigint): Promise<void> {
    await this.db.query(
      `insert into observer_cursors (name, block) values ($1, $2) on conflict (name) do update set block = excluded.block`,
      [name, block.toString()],
    );
  }
}

export { bookVaultMovements, checkVaults, type VaultBookingOptions, type VaultBookingResult, type VaultCheck, type VaultRef } from "./vaults.ts";
export { exceptions, readOnlyCsv, reconcileReadOnly, summarizeReadOnly, type PayoutRecord, type ReadOnlyOptions, type ReadOnlyResult, type ReadOnlyStatus } from "./readonly.ts";
