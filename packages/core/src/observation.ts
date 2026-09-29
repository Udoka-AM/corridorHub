import type { Asset, Venue } from "./model.ts";
import type { Hex } from "./reference.ts";

/**
 * What an observer saw happen on a venue. Tempo log watchers, Solana memo
 * scanners, partner webhooks and the Zcash viewing-key scanner all emit this
 * same shape, so one reconciliation engine serves every lane.
 */
export interface Observation {
  venue: Venue;
  /** Unique id of the movement on that venue, e.g. `${txHash}:${logIndex}`. */
  externalRef: string;
  reference: Hex | null;
  asset: Asset;
  amount: bigint;
  from?: string;
  to?: string;
  blockNumber?: bigint;
  observedAt: Date;
}
