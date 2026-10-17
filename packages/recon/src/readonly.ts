import type { Asset, Hex, Observation, Venue } from "@corridor/core";

/**
 * Read-only reconciliation: the first thing a payment company runs, before
 * Corridor moves any money. Inputs are the company's own payout records and
 * what watch-only observers saw on its existing wallets. No keys, no ledger
 * writes, nothing moves.
 *
 * Matching order for each record:
 * 1. by Corridor Reference, when the movement carried one (Stellar MEMO_HASH, Solana memo);
 * 2. otherwise by venue + asset + counterparty (when the record names one) +
 *    amount, nearest in time within a window.
 */

export interface PayoutRecord {
  /** The company's own id for the payout (from its core system). */
  id: string;
  venue: Venue;
  asset: Asset;
  /** Minor units the company expects to have moved. */
  amount: bigint;
  /** Counterparty address: the partner deposit address for payouts, the payer for collections. */
  counterparty?: string;
  direction: "out" | "in";
  reference?: Hex;
  /** When the company initiated it. */
  createdAt: Date;
}

export type ReadOnlyStatus =
  /** Seen on-chain with the expected amount. */
  | "matched"
  /** Seen, but less arrived or left than expected. */
  | "short"
  /** Seen, but more than expected. */
  | "over"
  /** Expected, not seen yet, still inside the grace period. */
  | "pending"
  /** Expected, not seen, past the grace period: chase it. */
  | "missing"
  /** Seen on-chain with no matching record: an unidentified movement. */
  | "unexpected";

export interface ReadOnlyResult {
  status: ReadOnlyStatus;
  record?: PayoutRecord;
  observation?: Observation;
  /** observed − expected, in minor units (when both exist). */
  difference?: bigint;
  matchedBy?: "reference" | "amount_and_counterparty";
}

export interface ReadOnlyOptions {
  /** How long after `createdAt` a movement may still appear. Default 30 minutes. */
  graceMs?: number;
  /** How far from `createdAt` a heuristic match may be. Default 6 hours. */
  windowMs?: number;
  now?: Date;
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function reconcileReadOnly(records: PayoutRecord[], observations: Observation[], opts: ReadOnlyOptions = {}): ReadOnlyResult[] {
  const graceMs = opts.graceMs ?? 30 * 60_000;
  const windowMs = opts.windowMs ?? 6 * 3_600_000;
  const now = opts.now ?? new Date();
  const unused = new Set(observations.map((_, i) => i));
  const results: ReadOnlyResult[] = [];

  const settle = (record: PayoutRecord, i: number, matchedBy: ReadOnlyResult["matchedBy"]) => {
    unused.delete(i);
    const observation = observations[i]!;
    const difference = observation.amount - record.amount;
    results.push({ status: difference === 0n ? "matched" : difference < 0n ? "short" : "over", record, observation, difference, matchedBy });
  };

  // Pass 1: references are exact.
  const pending: PayoutRecord[] = [];
  for (const record of records) {
    const i = record.reference ? [...unused].find((j) => observations[j]!.reference === record.reference && observations[j]!.venue === record.venue) : undefined;
    if (i !== undefined) settle(record, i, "reference");
    else pending.push(record);
  }

  // Pass 2: same venue, asset, direction and counterparty; exact amount first, then nearest in time.
  for (const record of pending) {
    const candidates = [...unused].filter((j) => {
      const o = observations[j]!;
      const counterparty = record.direction === "out" ? o.to : o.from;
      const dt = Math.abs(o.observedAt.getTime() - record.createdAt.getTime());
      const counterpartyOk = record.counterparty ? same(counterparty, record.counterparty) : true;
      const directionOk = record.direction === "out" ? !!o.to : !!o.from;
      return o.venue === record.venue && o.asset === record.asset && !o.reference && counterpartyOk && directionOk && dt <= windowMs;
    });
    const score = (j: number) => {
      const o = observations[j]!;
      return [o.amount === record.amount ? 0 : 1, Math.abs(o.observedAt.getTime() - record.createdAt.getTime())] as const;
    };
    candidates.sort((a, b) => {
      const [ea, ta] = score(a);
      const [eb, tb] = score(b);
      return ea - eb || ta - tb;
    });
    if (candidates[0] !== undefined) settle(record, candidates[0], "amount_and_counterparty");
    else results.push({ status: now.getTime() - record.createdAt.getTime() > graceMs ? "missing" : "pending", record });
  }

  for (const i of unused) results.push({ status: "unexpected", observation: observations[i]! });
  return results;
}

export function summarizeReadOnly(results: ReadOnlyResult[]): Record<ReadOnlyStatus, number> {
  const out: Record<ReadOnlyStatus, number> = { matched: 0, short: 0, over: 0, pending: 0, missing: 0, unexpected: 0 };
  for (const r of results) out[r.status]++;
  return out;
}

/** Everything that needs a person: the morning exceptions queue. */
export function exceptions(results: ReadOnlyResult[]): ReadOnlyResult[] {
  return results.filter((r) => r.status === "short" || r.status === "over" || r.status === "missing" || r.status === "unexpected");
}

const CSV_COLUMNS = ["status", "record_id", "venue", "asset", "expected", "observed", "difference", "counterparty", "external_ref", "reference", "matched_by", "created_at", "observed_at"] as const;

function cell(v: unknown): string {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV for finance teams and spreadsheets; amounts stay in integer minor units so nothing is rounded. */
export function readOnlyCsv(results: ReadOnlyResult[]): string {
  const rows = results.map((r) => {
    const o = r.observation;
    const rec = r.record;
    const counterparty = rec?.counterparty ?? (o ? (o.reference ? undefined : o.from ?? o.to) : undefined);
    return [
      r.status,
      rec?.id,
      rec?.venue ?? o?.venue,
      rec?.asset ?? o?.asset,
      rec?.amount,
      o?.amount,
      r.difference,
      counterparty,
      o?.externalRef,
      rec?.reference ?? o?.reference,
      r.matchedBy,
      rec?.createdAt.toISOString(),
      o?.observedAt.toISOString(),
    ].map(cell).join(",");
  });
  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
