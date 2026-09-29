import { mkdirSync } from "node:fs";
import type { Address } from "viem";
import { money, toZcashMemo, type Hex } from "@corridor/core";
import { findTransfersByReference, transferWithReference, type TempoClient } from "@corridor/chain-tempo";
import { shieldedObservations, type FrostSigner, type ShieldedPayment, type ZcashWallet } from "@corridor/chain-zcash";
import type { Db } from "@corridor/ledger";
import { ManualReviewError, NonRetryableError, amountOf, type Json, type Leg, type LegContext, type PayoutData } from "@corridor/saga";
import { NEAR_ASSETS, quoteSwap, usdPerZec } from "@corridor/swap-near";

/**
 * The shielded lane as saga legs, planned by the same route planner and run by
 * the same engine as every public payout:
 *
 *   ledger.reserve → near.swap → zcash.shieldedBatch
 *
 * near.swap        USD out of the hub into ZEC delivered to the customer's
 *                  FROST vault (NEAR Intents on mainnet; on testnet the rate
 *                  is a live mainnet quote and delivery is real testnet ZEC)
 * zcash.shieldedBatch  one Ironwood transaction paying every recipient, built
 *                  as a PCZT, held until `threshold` of the vault's FROST
 *                  signers approve, then co-signed and broadcast
 */

// ---------------------------------------------------------------------------
// Durable stores
// ---------------------------------------------------------------------------

const SCHEMA = /* sql */ `
create table if not exists leg_artifacts (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists approval_requests (
  subject    text primary key,
  kind       text not null,
  threshold  int not null,
  signers    int not null,
  summary    jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists approvals (
  subject     text not null,
  signer      int not null,
  approved_at timestamptz not null default now(),
  primary key (subject, signer)
);
`;

/** Per-step facts a leg must never redo (a delivery sent, a transaction broadcast). */
export class ArtifactStore {
  private constructor(private readonly db: Db) {}
  static async open(db: Db) {
    await db.exec(SCHEMA);
    return new ArtifactStore(db);
  }
  async get<T extends Json>(key: string): Promise<T | undefined> {
    const { rows } = await this.db.query<{ value: T }>(`select value from leg_artifacts where key = $1`, [key]);
    return rows[0]?.value;
  }
  async merge(key: string, patch: Record<string, Json>): Promise<void> {
    await this.db.query(
      `insert into leg_artifacts (key, value) values ($1, $2)
       on conflict (key) do update set value = leg_artifacts.value || excluded.value, updated_at = now()`,
      [key, JSON.stringify(patch)],
    );
  }
}

export interface ApprovalRequest {
  subject: string;
  kind: string;
  threshold: number;
  signers: number;
  summary: Record<string, Json>;
  approvedBy: number[];
  createdAt: Date;
}

/** Human approvals, e.g. FROST signers approving a shielded batch before it is signed. */
export class ApprovalStore {
  private constructor(private readonly db: Db) {}
  static async open(db: Db) {
    await db.exec(SCHEMA);
    return new ApprovalStore(db);
  }
  async request(subject: string, kind: string, threshold: number, signers: number, summary: Record<string, Json>) {
    await this.db.query(
      `insert into approval_requests (subject, kind, threshold, signers, summary) values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [subject, kind, threshold, signers, JSON.stringify(summary)],
    );
  }
  async approve(subject: string, signer: number) {
    const req = (await this.db.query<{ signers: number }>(`select signers from approval_requests where subject = $1`, [subject])).rows[0];
    if (!req) throw new Error(`no approval request for ${subject}`);
    if (!Number.isInteger(signer) || signer < 1 || signer > req.signers) throw new Error(`signer must be 1..${req.signers}`);
    await this.db.query(`insert into approvals (subject, signer) values ($1,$2) on conflict do nothing`, [subject, signer]);
  }
  async approvedBy(subject: string): Promise<number[]> {
    const { rows } = await this.db.query<{ signer: number }>(`select signer from approvals where subject = $1 order by approved_at`, [subject]);
    return rows.map((r) => r.signer);
  }
  async list(limit = 20): Promise<ApprovalRequest[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `select r.*, coalesce((select json_agg(a.signer order by a.approved_at) from approvals a where a.subject = r.subject), '[]') approved
         from approval_requests r order by r.created_at desc limit $1`,
      [limit],
    );
    return rows.map((r) => ({
      subject: r.subject,
      kind: r.kind,
      threshold: r.threshold,
      signers: r.signers,
      summary: r.summary,
      approvedBy: r.approved,
      createdAt: new Date(r.created_at),
    }));
  }
}

// ---------------------------------------------------------------------------
// Saga data for a shielded batch
// ---------------------------------------------------------------------------

export interface ShieldedItem {
  [k: string]: Json;
  itemId: string;
  /** Per-recipient Corridor Reference: only ever inside that recipient's encrypted memo. */
  reference: Hex;
  name: string;
  address: string;
  /** Share of the batch in USD, e.g. "5.00". */
  usd: string;
  invoiceRef: string;
}

const itemsOf = (d: PayoutData): ShieldedItem[] => {
  const r = d.recipient as { kind?: string; items?: ShieldedItem[] };
  if (r.kind !== "shielded" || !r.items?.length) throw new NonRetryableError("shielded payout needs recipient.items");
  return r.items;
};
const batchRef = (d: PayoutData) => (d.batchReference ?? d.reference) as Hex;

async function zecAccounts(ctx: LegContext<PayoutData>, vaultName: string) {
  const a = ctx.accounts;
  const d = ctx.data;
  return {
    treasury: await a.vault("treasury", "pathUSD", "tempo"),
    hold: await a.customerHold(d.customerId, d.corridor, d.asset, d.venue),
    pegUsd: await a.clearing("usd-zec", "pathUSD", "tempo"),
    pegZec: await a.clearing("usd-zec", "ZEC", "zcash_ironwood"),
    vault: await a.vault(vaultName, "ZEC", "zcash_ironwood"),
    liability: await a.customer(d.customerId, d.corridor, "ZEC", "zcash_ironwood"),
    fees: await a.open({ type: "expense", ownerType: "expense", ownerId: "zcash-fees", asset: "ZEC", venue: "zcash_ironwood" }),
  };
}

// ---------------------------------------------------------------------------
// near.swap (testnet execution)
// ---------------------------------------------------------------------------

export interface NearSwapOptions {
  artifacts: ArtifactStore;
  /** Tempo leg: pathUSD leaves the treasury for the swap venue. */
  treasury: TempoClient;
  swapEscrow: TempoClient;
  zcash: ZcashWallet;
  /** Testnet stand-in for the NEAR Intents solver: an account holding testnet ZEC. */
  deliveryAccount: string;
  vaultAccount: string;
  vaultName: string;
  /** Mainnet addresses used only to request a live mainnet quote. */
  quoteRecipient: string;
  quoteRefundTo: string;
  confirmTimeoutMs?: number;
}

export function nearSwapTestnetLeg(opts: NearSwapOptions): Leg<PayoutData> {
  return {
    kind: "near.swap",
    maxAttempts: 2,
    async forward(ctx) {
      const d = ctx.data;
      const usd = BigInt(d.amount); // pathUSD and USDC both have 6 decimals
      const ref = batchRef(d);
      const art = (await opts.artifacts.get<Record<string, Json>>(ctx.idempotencyKey)) ?? {};

      // 1. The rate: a live mainnet NEAR Intents quote, USDC (Base) → ZEC.
      let quote = art.quote as Record<string, Json> | undefined;
      if (!quote) {
        const q = await quoteSwap({ originAsset: NEAR_ASSETS.baseUSDC, destinationAsset: NEAR_ASSETS.ZEC, amount: usd, recipient: opts.quoteRecipient, refundTo: opts.quoteRefundTo });
        quote = { amountInUsd: q.amountInUsd, amountOut: q.amountOut.toString(), minAmountOut: q.minAmountOut.toString(), usdPerZec: Math.round(usdPerZec(q) * 100) / 100, timeEstimate: q.timeEstimate, source: "1click.chaindefuser.com (mainnet, dry)" };
        await opts.artifacts.merge(ctx.idempotencyKey, { quote });
      }
      const zat = BigInt(quote.amountOut as string);

      // 2. Real Tempo leg: pathUSD leaves the treasury toward the swap venue, batch reference as memo.
      let tempoMove = art.tempoMove as string | undefined;
      if (!tempoMove) {
        const existing = (await findTransfersByReference(opts.treasury, { asset: "pathUSD", reference: ref, fromBlock: BigInt(d.tempoStartBlock ?? "0") })).find(
          (o) => o.to?.toLowerCase() === opts.swapEscrow.account.address.toLowerCase() && o.amount === usd,
        );
        tempoMove = existing?.externalRef ?? (await transferWithReference(opts.treasury, { asset: "pathUSD", to: opts.swapEscrow.account.address as Address, amount: usd, reference: ref })).externalRef;
        await opts.artifacts.merge(ctx.idempotencyKey, { tempoMove });
      }

      // 3. Real testnet ZEC delivered into the FROST vault (NEAR Intents delivers straight to the vault's unified address).
      let deliveryTx = art.deliveryTx as string | undefined;
      if (!deliveryTx) {
        if (opts.zcash.spendable(opts.deliveryAccount) < zat + 50_000n) {
          throw new NonRetryableError(`testnet delivery account holds too little ZEC for ${zat} zat; claim more TAZ`);
        }
        const vaultAddress = opts.zcash.defaultAddress(opts.vaultAccount);
        deliveryTx = opts.zcash.payBatch(opts.deliveryAccount, [{ address: vaultAddress, zatoshi: zat, memo: toZcashMemo(ref, "NEAR Intents delivery (testnet)") }]);
        await opts.artifacts.merge(ctx.idempotencyKey, { deliveryTx });
      }
      const ready = await opts.zcash.syncUntil(() => opts.zcash.spendable(opts.vaultAccount) >= zat, { timeoutMs: opts.confirmTimeoutMs });
      if (!ready) throw new Error(`ZEC delivery ${deliveryTx} not yet spendable in the vault`);
      // Book the delivery under the output the observers (and an auditor's viewing key) will see.
      const received = shieldedObservations(
        opts.zcash.outputs().filter((o) => o.txid === deliveryTx && o.toAccount === opts.vaultAccount),
      )[0];
      if (!received) throw new Error(`delivery ${deliveryTx} has no output to the vault yet`);

      const acct = await zecAccounts(ctx, opts.vaultName);
      return {
        output: { quote, tempoMove, deliveryTx, zecDelivered: zat.toString() },
        bookings: [
          {
            kind: "near.swap.out",
            reference: d.reference,
            sagaId: ctx.sagaId,
            external: { venue: "tempo", ref: tempoMove },
            lines: [
              { account: acct.pegUsd, direction: "D", money: money("pathUSD", usd) },
              { account: acct.treasury, direction: "C", money: money("pathUSD", usd) },
            ],
          },
          {
            kind: "near.swap.delivery",
            reference: d.reference,
            sagaId: ctx.sagaId,
            external: { venue: "zcash_ironwood", ref: received.externalRef },
            metadata: { quote, testnetDelivery: true },
            lines: [
              { account: acct.vault, direction: "D", money: money("ZEC", zat) },
              { account: acct.pegZec, direction: "C", money: money("ZEC", zat) },
            ],
          },
          {
            kind: "near.swap.convert",
            reference: d.reference,
            sagaId: ctx.sagaId,
            metadata: { usdPerZec: quote.usdPerZec },
            lines: [
              { account: acct.hold, direction: "D", money: amountOf(d) },
              { account: acct.pegUsd, direction: "C", money: amountOf(d) },
              { account: acct.pegZec, direction: "D", money: money("ZEC", zat) },
              { account: acct.liability, direction: "C", money: money("ZEC", zat) },
            ],
          },
        ],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// zcash.shieldedBatch
// ---------------------------------------------------------------------------

export interface ShieldedBatchOptions {
  artifacts: ArtifactStore;
  approvals: ApprovalStore;
  zcash: ZcashWallet;
  frost: FrostSigner;
  vaultAccount: string;
  vaultName: string;
  workDir: string;
  /** Kept back from the delivered ZEC for the batch's ZIP-317 fee. */
  feeReserveZat?: bigint;
  approvalTimeoutMs?: number;
  confirmTimeoutMs?: number;
}

export function shieldedBatchLeg(opts: ShieldedBatchOptions): Leg<PayoutData> {
  return {
    kind: "zcash.shieldedBatch",
    maxAttempts: 1,
    async forward(ctx) {
      const d = ctx.data;
      const items = itemsOf(d);
      const subject = batchRef(d);
      const art = (await opts.artifacts.get<Record<string, Json>>(ctx.idempotencyKey)) ?? {};
      const vault = opts.frost.vault();

      let txid = art.txid as string | undefined;
      let approvedBy = (art.approvedBy as number[] | undefined) ?? [];
      let payments = art.payments as { itemId: string; zatoshi: string }[] | undefined;

      if (!txid) {
        // Split the delivered ZEC across recipients by their USD share, keeping the fee back.
        const swapOut = Object.values(ctx.outputs).find((o) => (o as { zecDelivered?: string } | null)?.zecDelivered) as { zecDelivered: string } | undefined;
        if (!swapOut) throw new NonRetryableError("no ZEC delivered by an earlier near.swap step");
        const distributable = BigInt(swapOut.zecDelivered) - (opts.feeReserveZat ?? 30_000n);
        const totalCents = items.reduce((s, it) => s + BigInt(Math.round(Number(it.usd) * 100)), 0n);
        payments = items.map((it) => ({ itemId: it.itemId, zatoshi: ((distributable * BigInt(Math.round(Number(it.usd) * 100))) / totalCents).toString() }));
        const outs: ShieldedPayment[] = items.map((it, i) => ({ address: it.address, zatoshi: BigInt(payments![i]!.zatoshi), memo: toZcashMemo(it.reference, it.invoiceRef) }));

        mkdirSync(opts.workDir, { recursive: true });
        const base = `${opts.workDir}/${ctx.sagaId}`;
        opts.zcash.pcztCreateBatch(opts.vaultAccount, outs, `${base}.unsigned.pczt`);
        opts.zcash.pcztProve(`${base}.unsigned.pczt`, `${base}.proved.pczt`);

        // Held for the vault's signers. Nothing is signed until the threshold approves.
        await opts.approvals.request(subject, "shielded-batch", vault.threshold, vault.signers, {
          sagaId: ctx.sagaId,
          customer: d.customerId,
          recipients: items.length,
          usd: items.reduce((s, it) => s + Number(it.usd), 0).toFixed(2),
          zec: (Number(distributable) / 1e8).toFixed(8),
          invoices: items.map((it) => it.invoiceRef),
        });
        const deadline = Date.now() + (opts.approvalTimeoutMs ?? 60 * 60_000);
        while ((approvedBy = await opts.approvals.approvedBy(subject)).length < vault.threshold) {
          if (Date.now() > deadline) throw new NonRetryableError(`batch not approved by ${vault.threshold} signers in time`);
          await new Promise((r) => setTimeout(r, 2_000));
        }
        approvedBy = approvedBy.slice(0, vault.threshold);

        const signed = opts.frost.sign(`${base}.unsigned.pczt`, approvedBy, `${base}.signed.pczt`);
        if (signed.signed === 0) throw new NonRetryableError("no vault spends were signed");
        opts.zcash.pcztCombine([`${base}.proved.pczt`, `${base}.signed.pczt`], `${base}.final.pczt`);
        txid = opts.zcash.pcztSend(`${base}.final.pczt`);
        await opts.artifacts.merge(ctx.idempotencyKey, { txid, approvedBy, payments, sighash: signed.sighash });
      }

      // After broadcast, failures are for a human: the batch may already be on-chain.
      const mined = await opts.zcash.syncUntil(() => opts.zcash.isMined(txid!), { timeoutMs: opts.confirmTimeoutMs });
      if (!mined) throw new ManualReviewError(`shielded batch ${txid} broadcast but not mined in time`);

      const sent = shieldedObservations(opts.zcash.outputs().filter((o) => o.txid === txid && o.fromAccount === opts.vaultAccount));
      const byRef = new Map(items.map((it) => [it.reference, it]));
      const acct = await zecAccounts(ctx, opts.vaultName);
      const fee = opts.zcash.txFee(txid);
      const bookings = sent
        .filter((o) => o.reference && byRef.has(o.reference))
        .map((o) => ({
          kind: "zcash.shieldedBatch.item",
          reference: o.reference!,
          sagaId: ctx.sagaId,
          external: { venue: "zcash_ironwood" as const, ref: o.externalRef },
          metadata: { txid, invoiceRef: byRef.get(o.reference!)!.invoiceRef, approvedBy },
          lines: [
            { account: acct.liability, direction: "D" as const, money: money("ZEC", o.amount) },
            { account: acct.vault, direction: "C" as const, money: money("ZEC", o.amount) },
          ],
        }));
      if (bookings.length !== items.length) throw new ManualReviewError(`batch ${txid}: ${bookings.length}/${items.length} outputs found`);
      if (fee > 0n) {
        bookings.push({
          kind: "zcash.fee",
          reference: subject,
          sagaId: ctx.sagaId,
          external: { venue: "zcash_ironwood", ref: `${txid}:fee` },
          metadata: { txid, invoiceRef: "fee", approvedBy },
          lines: [
            { account: acct.fees, direction: "D", money: money("ZEC", fee) },
            { account: acct.vault, direction: "C", money: money("ZEC", fee) },
          ],
        });
      }
      return {
        output: { txid, approvedBy, recipients: items.length, fee: fee.toString(), explorer: `https://testnet.zcashexplorer.app/transactions/${txid}` },
        bookings,
      };
    },
  };
}
