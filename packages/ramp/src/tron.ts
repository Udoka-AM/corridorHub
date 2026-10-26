import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import type { Hex } from "@corridor/core";
import type { CctpNetwork, Iris, StellarMintOptions } from "@corridor/bridge-cctp";
import type { Db } from "@corridor/ledger";
import { CctpMintStore, TronBurnStore, cctpTransferLeg, tronBurnLeg, tronSwapLeg } from "@corridor/legs";
import type { Leg } from "@corridor/saga";
import { OneClick } from "@corridor/swap-intents";
import type { RoutePlan } from "@corridor/routing";

/**
 * The Tron deposit lane, as Ramp exposes it.
 *
 * USDT on Tron becomes USDC on the user's Stellar account in three recorded
 * steps: a solver swap to Solana, a CCTP burn there, and the mint on the hub.
 * The USDC in between is the user's own — it lands at the Solana address of
 * their Stellar key, and their key signs the burn — so Ramp never holds it
 * (ADR 0015). What Ramp supplies is the quote, the watching, and the Solana
 * fee, because an address derived from a Stellar key starts with no SOL.
 *
 * The lane is optional. A deployment without a Solana fee payer and a signer
 * it may use on the user's behalf cannot offer it, so the endpoints answer
 * `not_configured` rather than existing and failing at the burn.
 */

export interface TronLaneOptions {
  oneClick?: OneClick;
  /** Circle's attestation service, for the mint half. */
  iris: Iris;
  network: CctpNetwork;
  /** Everything needed to sign and submit the mint on Stellar. */
  mint: Omit<StellarMintOptions, "network" | "onSubmitted">;
  usdcMint: Address;
  /** Pays the Solana fee. Never the owner, so it cannot move the USDC. */
  feePayer: TransactionSigner;
  /** The user's Solana signer, which the app's wallet supplies. */
  ownerFor: (stellarAccount: string) => Promise<TransactionSigner>;
  /** Signs and submits the burn instruction. */
  submit: (instruction: Instruction) => Promise<string>;
  /** Hundredths of a percent the solver may slip. Default 1%. */
  slippageBps?: number;
  /** How long a deposit address stays good for. Default 15 minutes. */
  ttlMinutes?: number;
  /** Polling cadence for the swap and the attestation. */
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type TronDepositStatus = "awaiting_deposit" | "processing" | "completed" | "failed" | "manual_review";

export interface TronDeposit {
  id: string;
  tenantId: string;
  keyId: string;
  /** The user's Stellar account, where the USDC lands. */
  account: string;
  /** The same key on Solana, where the swap pays out. */
  solanaAddress: string;
  /** The user's Tron address, where an unfilled swap is refunded. */
  refundTo: string;
  /** The solver's one-off Tron address the user sends USDT to. */
  depositAddress: string;
  tronAmount: bigint;
  expectedUsdc: bigint;
  minUsdc: bigint;
  expiresAt: Date;
  status: TronDepositStatus;
  reference: Hex;
  sagaId?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SCHEMA = `
create table if not exists tron_deposits (
  id              text primary key,
  tenant_id       text not null,
  key_id          text not null,
  account         text not null,
  solana_address  text not null,
  refund_to       text not null,
  deposit_address text not null,
  tron_amount     numeric(78,0) not null,
  expected_usdc   numeric(78,0) not null,
  min_usdc        numeric(78,0) not null,
  expires_at      timestamptz not null,
  status          text not null,
  reference       text not null,
  saga_id         text,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists tron_deposits_tenant on tron_deposits (tenant_id, created_at desc);
`;

type Row = {
  id: string;
  tenant_id: string;
  key_id: string;
  account: string;
  solana_address: string;
  refund_to: string;
  deposit_address: string;
  tron_amount: string;
  expected_usdc: string;
  min_usdc: string;
  expires_at: Date;
  status: string;
  reference: string;
  saga_id: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
};

function hydrate(r: Row): TronDeposit {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    keyId: r.key_id,
    account: r.account,
    solanaAddress: r.solana_address,
    refundTo: r.refund_to,
    depositAddress: r.deposit_address,
    tronAmount: BigInt(r.tron_amount),
    expectedUsdc: BigInt(r.expected_usdc),
    minUsdc: BigInt(r.min_usdc),
    expiresAt: new Date(r.expires_at),
    status: r.status as TronDepositStatus,
    reference: r.reference as Hex,
    sagaId: r.saga_id ?? undefined,
    error: r.error ?? undefined,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

export class TronDepositStore {
  private constructor(private readonly db: Db) {}

  static async open(db: Db): Promise<TronDepositStore> {
    await db.exec(SCHEMA);
    return new TronDepositStore(db);
  }

  async insert(d: TronDeposit): Promise<void> {
    await this.db.query(
      `insert into tron_deposits
         (id, tenant_id, key_id, account, solana_address, refund_to, deposit_address,
          tron_amount, expected_usdc, min_usdc, expires_at, status, reference, saga_id, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        d.id, d.tenantId, d.keyId, d.account, d.solanaAddress, d.refundTo, d.depositAddress,
        d.tronAmount.toString(), d.expectedUsdc.toString(), d.minUsdc.toString(),
        d.expiresAt.toISOString(), d.status, d.reference, d.sagaId ?? null,
        d.createdAt.toISOString(), d.updatedAt.toISOString(),
      ],
    );
  }

  async patch(tenantId: string, id: string, p: { status?: TronDepositStatus; sagaId?: string; error?: string | null; updatedAt: Date }): Promise<void> {
    await this.db.query(
      `update tron_deposits
          set status = coalesce($3, status),
              saga_id = coalesce($4, saga_id),
              error = case when $6 then $5 else error end,
              updated_at = $7
        where tenant_id = $1 and id = $2`,
      [tenantId, id, p.status ?? null, p.sagaId ?? null, p.error ?? null, p.error !== undefined, p.updatedAt.toISOString()],
    );
  }

  async get(tenantId: string, id: string): Promise<TronDeposit | undefined> {
    const { rows } = await this.db.query<Row>(`select * from tron_deposits where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? hydrate(rows[0]) : undefined;
  }

  /**
   * Deposits whose saga still has work, across every tenant, for the ticker.
   *
   * A deposit nobody funds stays here until its swap leg has exhausted its
   * attempts and the saga fails on its own — the store does not decide that,
   * because the solver can still fill a late deposit the engine has not yet
   * given up on.
   */
  async pending(limit = 50): Promise<TronDeposit[]> {
    const { rows } = await this.db.query<Row>(
      `select * from tron_deposits
        where status in ('awaiting_deposit','processing') and saga_id is not null
        order by updated_at limit $1`,
      [limit],
    );
    return rows.map(hydrate);
  }

  async list(tenantId: string, limit = 25): Promise<TronDeposit[]> {
    const { rows } = await this.db.query<Row>(
      `select * from tron_deposits where tenant_id = $1 order by created_at desc limit $2`,
      [tenantId, limit],
    );
    return rows.map(hydrate);
  }
}

/**
 * The lane's three legs, for the saga engine.
 *
 * Returns nothing when the deployment has not configured the lane, so the
 * engine is not registered with legs it cannot run.
 */
export async function tronLaneLegs(db: Db, opts: TronLaneOptions | undefined): Promise<Leg[]> {
  if (!opts) return [];
  return [
    tronSwapLeg({
      oneClick: opts.oneClick ?? new OneClick(),
      pollMs: opts.pollMs,
      timeoutMs: opts.timeoutMs,
      sleep: opts.sleep,
    }),
    tronBurnLeg({
      network: opts.network,
      burns: await TronBurnStore.open(db),
      usdcMint: opts.usdcMint,
      feePayer: opts.feePayer,
      ownerFor: opts.ownerFor,
      submit: opts.submit,
    }),
    cctpTransferLeg({
      iris: opts.iris,
      mints: await CctpMintStore.open(db),
      network: opts.network,
      mint: opts.mint,
      pollMs: opts.pollMs,
      timeoutMs: opts.timeoutMs,
    }),
  ] as Leg[];
}

/**
 * The lane's route plan.
 *
 * Tron is not a venue — Corridor holds no balance there — so the first two
 * steps are described by where their output lands rather than where the money
 * came from. Only the last step crosses a venue boundary Corridor's books
 * care about, and it is the only one that posts an entry.
 */
export function tronDepositPlan(): RoutePlan {
  const solana = { venue: "solana", asset: "USDC" } as const;
  const stellar = { venue: "stellar", asset: "USDC" } as const;
  return {
    corridor: "USD-USD",
    purpose: "collection",
    privacy: "public",
    steps: [
      { index: 0, kind: "tron.swap", from: solana, to: solana, referenceScope: "payout" },
      { index: 1, kind: "tron.burn", from: solana, to: solana, referenceScope: "payout" },
      { index: 2, kind: "cctp.transfer", from: solana, to: stellar, referenceScope: "payout" },
    ],
  } as unknown as RoutePlan;
}

/** The order's status, read off the saga rather than tracked a second time. */
export function tronStatusOf(saga: { status: string; steps: { status: string }[] }): TronDepositStatus {
  if (saga.status === "completed") return "completed";
  if (saga.status === "manual_review") return "manual_review";
  if (saga.status === "compensated" || saga.status === "compensating") return "failed";
  // The swap step is still waiting for the user's USDT until it has run once.
  const swap = saga.steps[0];
  return swap && swap.status === "done" ? "processing" : "awaiting_deposit";
}
