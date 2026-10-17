import { fromStellarMemo, type Asset, type Hex, type Observation } from "@corridor/core";
import { NATIVE, assetOf, fromStellarAmount, type StellarNetwork } from "./assets.ts";

/**
 * The Horizon payment records Corridor reads, with the transaction joined in
 * so the memo (and therefore the Corridor Reference) arrives in the same
 * call. Only the fields Corridor uses are declared.
 */
export interface StellarPaymentRecord {
  id: string;
  paging_token: string;
  type: string;
  transaction_hash: string;
  created_at: string;
  transaction_successful?: boolean;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  /** payment and path_payment */
  from?: string;
  to?: string;
  amount?: string;
  /** create_account */
  funder?: string;
  account?: string;
  starting_balance?: string;
  transaction?: {
    memo?: string;
    memo_type?: string;
    ledger?: number;
    source_account?: string;
    fee_charged?: string;
    successful?: boolean;
  };
}

/**
 * The SDK turns every Horizon `_links` entry into a method, so on an
 * operation record `transaction` is a link-follower and the joined
 * transaction sits in `transaction_attr` — and inside that, `ledger` is a
 * link-follower too, with the sequence in `ledger_attr`. Normalising here
 * keeps those quirks at the edge, so everything downstream reads the plain
 * Horizon JSON shape above.
 */
export function normalizeRecord(raw: unknown): StellarPaymentRecord {
  type Joined = NonNullable<StellarPaymentRecord["transaction"]> & { ledger_attr?: number };
  const record = raw as StellarPaymentRecord & { transaction_attr?: Joined };
  const joined: Joined | undefined = record.transaction_attr ?? (typeof record.transaction === "object" ? record.transaction : undefined);
  const { transaction_attr: _ignored, ...rest } = record;
  if (!joined) return { ...rest, transaction: undefined };
  const ledger = typeof joined.ledger === "number" ? joined.ledger : joined.ledger_attr;
  return {
    ...rest,
    transaction: {
      memo: joined.memo,
      memo_type: joined.memo_type,
      ledger,
      source_account: joined.source_account,
      fee_charged: joined.fee_charged,
      successful: joined.successful,
    },
  };
}

/**
 * The ledger an operation landed in, from its TOID: Horizon packs the ledger
 * sequence into the high 32 bits of every operation id, and the joined
 * transaction does not carry the sequence itself.
 */
export function ledgerOf(pagingToken: string): bigint | undefined {
  try {
    return BigInt(pagingToken) >> 32n;
  } catch {
    return undefined;
  }
}

/** Where payment history comes from. `horizonPayments` is the real one; tests pass a fake. */
export interface PaymentSource {
  /** Payments for `account` strictly after `cursor`, oldest first. */
  fetch(account: string, cursor: string | undefined, limit: number): Promise<StellarPaymentRecord[]>;
}

export interface CursorStore {
  get(name: string): Promise<bigint | undefined>;
  set(name: string, cursor: bigint): Promise<void>;
}

/**
 * Horizon has no index from memo to transaction, so a reference is never
 * looked up network-wide: it is joined against the payment stream of the
 * account Corridor already watches. That stream is per-vault and bounded, and
 * a stored paging token makes restarts neither miss nor double-count
 * (ADR 0003).
 */
export class StellarObserver {
  constructor(
    private readonly source: PaymentSource,
    private readonly opts: {
      name: string;
      network: StellarNetwork;
      /** Stellar accounts to watch: Corridor's vaults, or a customer's own wallets in read-only mode. */
      accounts: string[];
      cursors: CursorStore;
      /** Records per Horizon page. */
      pageSize?: number;
      /**
       * Also report movements that carry no reference: account funding and
       * sponsored reserves, plain inbound payments, and the XLM fee each
       * outbound transaction charged (booked against the transaction that
       * paid it, ADR 0008).
       */
      unreferenced?: boolean;
    },
  ) {}

  async poll(): Promise<Observation[]> {
    const { accounts, cursors, name, network } = this.opts;
    const pageSize = this.opts.pageSize ?? 200;
    const seen = new Map<string, Observation>();

    for (const account of accounts) {
      const key = accounts.length > 1 ? `${name}:${account}` : name;
      let cursor = (await cursors.get(key))?.toString();
      while (true) {
        const page = await this.source.fetch(account, cursor, pageSize);
        if (page.length === 0) break;
        for (const record of page) {
          for (const obs of this.observations(record, account, network)) seen.set(obs.externalRef, obs);
        }
        cursor = page.at(-1)!.paging_token;
        await cursors.set(key, BigInt(cursor));
        if (page.length < pageSize) break;
      }
    }

    return [...seen.values()].sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)));
  }

  private observations(record: StellarPaymentRecord, watched: string, network: StellarNetwork): Observation[] {
    if (record.transaction_successful === false || record.transaction?.successful === false) return [];

    const tx = record.transaction;
    const reference: Hex | null = tx?.memo ? fromStellarMemo(tx.memo, tx.memo_type) : null;
    const ledger = tx?.ledger === undefined ? ledgerOf(record.paging_token) : BigInt(tx.ledger);
    const observedAt = new Date(record.created_at);
    const base = { venue: "stellar" as const, reference, blockNumber: ledger, observedAt };
    const out: Observation[] = [];

    const movement = this.movement(record, network);
    if (movement && (reference !== null || this.opts.unreferenced)) {
      out.push({ ...base, externalRef: `${record.transaction_hash}:${record.id}`, ...movement });
    }

    // The fee is charged to the transaction's source account, in XLM, whether
    // or not the payment itself carried a reference.
    const fee = tx?.fee_charged;
    if (this.opts.unreferenced && fee && fee !== "0" && tx?.source_account === watched) {
      out.push({
        ...base,
        externalRef: `${record.transaction_hash}:fee`,
        asset: NATIVE,
        amount: BigInt(fee),
        from: watched,
      });
    }
    return out;
  }

  private movement(
    record: StellarPaymentRecord,
    network: StellarNetwork,
  ): { asset: Asset; amount: bigint; from?: string; to?: string } | null {
    if (record.type === "create_account") {
      // Funding and sponsored reserves arrive as XLM, before any trustline exists.
      if (!record.starting_balance) return null;
      return { asset: NATIVE, amount: fromStellarAmount(NATIVE, record.starting_balance), from: record.funder, to: record.account };
    }
    if (!record.amount || !record.from || !record.to) return null;
    // Code alone is not identity: an asset from an issuer Corridor does not
    // settle is simply not Corridor's asset.
    const asset = assetOf(record, network);
    if (!asset) return null;
    return { asset, amount: fromStellarAmount(asset, record.amount), from: record.from, to: record.to };
  }
}
