import type { Asset, Venue } from "./model.ts";
import type { Hex } from "./reference.ts";

/**
 * What an observer saw happen on a venue. The Horizon payment watcher, the
 * Solana memo scanner and anchor webhooks all emit this same shape, so one
 * reconciliation engine serves every lane.
 */
export interface Observation {
  venue: Venue;
  /** Unique id of the movement on that venue, e.g. `${txHash}:${operationId}`. */
  externalRef: string;
  reference: Hex | null;
  asset: Asset;
  amount: bigint;
  from?: string;
  to?: string;
  /** The ledger (Stellar) or block (Solana, Base) the movement landed in. */
  blockNumber?: bigint;
  observedAt: Date;
}
