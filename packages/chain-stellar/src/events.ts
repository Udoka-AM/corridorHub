import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Asset, Observation } from "@corridor/core";
import { assetOf, type StellarNetwork } from "./assets.ts";

/**
 * Soroban contract events, for the movements Horizon's payment stream does
 * not show.
 *
 * A classic asset moved by a contract — a CCTP mint through the forwarder, a
 * Soroban app paying a vault — goes through that asset's Stellar Asset
 * Contract and appears only as a contract event. The payment observer misses
 * it, which matters most in read-only mode, where Corridor watches accounts
 * it does not control and cannot know how value will arrive.
 *
 * The SAC `transfer` event carries topics `["transfer", from, to, asset]` and
 * an i128 amount already in the asset's own 7 decimals, so no conversion.
 */

export interface ContractEvent {
  /** `topic` on the RPC response: ScVals. */
  topic: xdr.ScVal[];
  value: xdr.ScVal;
  txHash: string;
  ledger: number;
  ledgerClosedAt: string;
  id?: string;
}

export interface EventPage {
  events: ContractEvent[];
  latestLedger: number;
  cursor?: string;
}

/** The slice of Soroban RPC this needs. Tests pass a fake. */
export interface EventSource {
  getEvents(args: {
    startLedger?: number;
    filters: { type: "contract"; contractIds: string[]; topics?: (string | "*")[][] }[];
    limit?: number;
    cursor?: string;
  }): Promise<EventPage>;
  getLatestLedger(): Promise<{ sequence: number }>;
}

export interface EventCursorStore {
  get(name: string): Promise<bigint | undefined>;
  set(name: string, ledger: bigint): Promise<void>;
}

const TRANSFER = xdr.ScVal.scvSymbol("transfer").toXDR("base64");

/** A `transfer` topic filter, with the three address/asset slots wild. */
export const TRANSFER_TOPICS: (string | "*")[][] = [[TRANSFER, "*", "*", "*"]];

/**
 * Watches the Stellar Asset Contracts of the assets Corridor books, and
 * reports transfers touching the watched accounts.
 *
 * The reference is always null: a memo belongs to the transaction, not the
 * event, so a contract-moved payment arrives unreferenced and reconciliation
 * says so rather than guessing. That is the honest answer for value Corridor
 * did not send.
 */
export class StellarEventObserver {
  constructor(
    private readonly source: EventSource,
    private readonly opts: {
      name: string;
      network: StellarNetwork;
      /** SAC address per asset, from `sacContractId`. */
      contracts: Partial<Record<Asset, string>>;
      accounts: string[];
      cursors: EventCursorStore;
      /** Where to start when no cursor exists. Defaults to the latest ledger. */
      startLedger?: number;
      pageSize?: number;
    },
  ) {}

  async poll(): Promise<Observation[]> {
    const { accounts, contracts, cursors, name } = this.opts;
    const contractIds = Object.values(contracts).filter((c): c is string => !!c);
    if (contractIds.length === 0) return [];
    const watched = new Set(accounts);
    const limit = this.opts.pageSize ?? 200;

    const stored = await cursors.get(name);
    const latest = await this.source.getLatestLedger();
    let startLedger = stored !== undefined ? Number(stored) + 1 : (this.opts.startLedger ?? latest.sequence);
    if (startLedger > latest.sequence) return [];

    const seen = new Map<string, Observation>();
    let cursor: string | undefined;
    let highest = startLedger - 1;

    while (true) {
      const page = await this.source.getEvents({
        ...(cursor ? { cursor } : { startLedger }),
        filters: [{ type: "contract", contractIds, topics: TRANSFER_TOPICS }],
        limit,
      });
      for (const event of page.events) {
        highest = Math.max(highest, event.ledger);
        const obs = this.observation(event, watched);
        if (obs) seen.set(obs.externalRef, obs);
      }
      if (page.events.length < limit || !page.cursor) {
        highest = Math.max(highest, page.latestLedger);
        break;
      }
      cursor = page.cursor;
    }

    if (highest >= startLedger) await cursors.set(name, BigInt(highest));
    return [...seen.values()].sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)));
  }

  private observation(event: ContractEvent, watched: Set<string>): Observation | null {
    const topics = event.topic.map((t) => {
      try {
        return scValToNative(t) as unknown;
      } catch {
        return null;
      }
    });
    const [kind, from, to, assetTopic] = topics;
    if (kind !== "transfer" || typeof from !== "string" || typeof to !== "string") return null;
    if (!watched.has(from) && !watched.has(to)) return null;

    const asset = this.assetOfTopic(assetTopic);
    if (!asset) return null;

    let amount: bigint;
    try {
      amount = BigInt(scValToNative(event.value) as string | bigint);
    } catch {
      return null;
    }

    return {
      venue: "stellar",
      externalRef: `${event.txHash}:${event.id ?? `${event.ledger}`}`,
      // A memo belongs to the transaction, not the event.
      reference: null,
      asset,
      amount,
      from,
      to,
      blockNumber: BigInt(event.ledger),
      observedAt: new Date(event.ledgerClosedAt),
    };
  }

  /** The SAC asset topic is `"native"` or `"CODE:ISSUER"`. Issuer decides identity (ADR 0007). */
  private assetOfTopic(topic: unknown): Asset | null {
    if (typeof topic !== "string") return null;
    if (topic === "native") return assetOf({ asset_type: "native" }, this.opts.network);
    const [code, issuer] = topic.split(":");
    if (!code || !issuer) return null;
    return assetOf({ asset_type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12", asset_code: code, asset_issuer: issuer }, this.opts.network);
  }
}
