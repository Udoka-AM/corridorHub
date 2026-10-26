import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { generateKeyPairSigner } from "@solana/kit";
import type { Hex } from "@corridor/core";
import { buildBurnToStellar, solanaAddressOfStellar, type CctpNetwork } from "@corridor/bridge-cctp";
import { OneClick, OneClickError, type SwapStatus } from "@corridor/swap-intents";
import type { Db } from "@corridor/ledger";
import { ManualReviewError, NonRetryableError, type Json, type Leg } from "@corridor/saga";

/**
 * The Tron lane: USDT on Tron becomes USDC on the Stellar hub, in two hops.
 *
 * Neither hop reaches all the way. 1Click does not route Stellar in either
 * direction, and CCTP does not reach Tron at all — so the lane goes Tron
 * USDT to Solana USDC through the solver network, then Solana to Stellar
 * over CCTP. Something has to own the USDC in between and sign the burn.
 *
 * Corridor does not. The swap pays out to the user's *own* Solana address,
 * which is the same Ed25519 key as their Stellar account, and the burn is
 * signed with that key. Corridor quotes, watches, pays the Solana fee, and
 * completes the mint — it is never in a position to spend the money. The one
 * thing it sponsors is gas: a Solana address derived from a Stellar key holds
 * no SOL, so the burn's fee payer is a Corridor vault while its owner is the
 * user, which is why `buildBurnToStellar` takes the two separately.
 */

/** What a user is told to do to start a Tron deposit. */
export interface TronDepositPlan {
  /** Send USDT to this address, on Tron. One-off, and good only until `expiresAt`. */
  depositAddress: string;
  /** Send exactly this, in USDT's 6 decimals. Less is held rather than filled. */
  amount: bigint;
  /** USDC the solver expects to deliver on Solana, 6 decimals. */
  expectedUsdc: bigint;
  /** The least it will deliver. Below this it refunds to `refundTo` instead. */
  minUsdc: bigint;
  /** Where the swap pays out: the user's own Solana address. */
  solanaAddress: string;
  /** Where the USDC ends up, once the burn is minted. */
  stellarAccount: string;
  expiresAt: string;
  timeEstimateSeconds: number;
  /** The solver's signature over the quote, kept for the dispute trail. */
  quoteSignature: string;
  correlationId?: string;
}

interface PlanArgs {
  oneClick: OneClick;
  /** The user's `G…` account; also, as the same key, their Solana address. */
  stellarAccount: string;
  /** USDT the user will send, in Tron's 6 decimals. */
  amount: bigint;
  /** The user's Tron address, where an unfilled swap is refunded. */
  refundTo: string;
  slippageBps?: number;
  ttlMinutes?: number;
}

/**
 * Price the lane without reserving anything, for a rate shown in a UI.
 *
 * The number it returns is the Solana hop only. The CCTP hop that follows
 * moves USDC one-for-one and costs a Stellar fee Corridor pays, so the USDC
 * that reaches the hub is this figure.
 */
export async function quoteTronDeposit(args: PlanArgs): Promise<{ expectedUsdc: bigint; minUsdc: bigint; timeEstimateSeconds: number }> {
  const quote = await args.oneClick.quote(
    {
      origin: "tron:USDT",
      destination: "solana:USDC",
      amount: args.amount,
      recipient: solanaAddressOfStellar(args.stellarAccount),
      refundTo: args.refundTo,
      slippageBps: args.slippageBps,
    },
    { dry: true },
  );
  return { expectedUsdc: quote.amountOut, minUsdc: quote.minAmountOut, timeEstimateSeconds: quote.timeEstimateSeconds };
}

/**
 * Take a live quote and return the instruction to hand the user.
 *
 * The deposit address belongs to the solver network, not to Corridor, and it
 * is tied to this one quote: the amount, the recipient and the refund
 * address are all fixed before the user sends anything.
 */
export async function planTronDeposit(args: PlanArgs): Promise<TronDepositPlan> {
  const solanaAddress = solanaAddressOfStellar(args.stellarAccount);
  const quote = await args.oneClick.quote({
    origin: "tron:USDT",
    destination: "solana:USDC",
    amount: args.amount,
    recipient: solanaAddress,
    refundTo: args.refundTo,
    slippageBps: args.slippageBps,
    deadline: new Date(Date.now() + (args.ttlMinutes ?? 15) * 60_000),
  });
  if (!quote.depositAddress) throw new OneClickError("1Click returned a live quote with no deposit address");
  return {
    depositAddress: quote.depositAddress,
    amount: quote.amountIn,
    expectedUsdc: quote.amountOut,
    minUsdc: quote.minAmountOut,
    solanaAddress,
    stellarAccount: args.stellarAccount,
    expiresAt: quote.deadline,
    timeEstimateSeconds: quote.timeEstimateSeconds,
    quoteSignature: quote.signature,
    correlationId: quote.correlationId,
  };
}

/** Saga data for a Tron deposit, written when the plan is handed out. */
export interface TronDepositData {
  [k: string]: Json | undefined;
  /** The solver's one-off Tron address the user was told to send to. */
  depositAddress: string;
  /** USDT the quote priced, in Tron's 6 decimals. */
  tronAmount: string;
  /** The user's own Solana address the swap pays out to. */
  solanaAddress: string;
  /** The user's Stellar account, where the minted USDC lands. */
  stellarAccount: string;
  /** The user's Tron address, for the refund path. */
  refundTo: string;
  reference: Hex;
}

export interface TronSwapLegOptions {
  oneClick: OneClick;
  /** How long to wait for the solver before giving up and retrying. */
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The `tron.swap` leg: wait for the solver network to deliver USDC to the
 * user's Solana address.
 *
 * It books nothing. Both sides of this hop are the user's own addresses, so
 * no Corridor balance moves until the CCTP mint credits the hub — which the
 * existing `cctp.transfer` leg books, from the burn this lane produces.
 */
export function tronSwapLeg(opts: TronSwapLegOptions): Leg<TronDepositData> {
  return {
    kind: "tron.swap",
    maxAttempts: 5,
    backoffMs: 10_000,
    async forward(ctx) {
      const d = ctx.data;
      const status = await opts.oneClick.waitForSwap({
        depositAddress: d.depositAddress,
        timeoutMs: opts.timeoutMs,
        pollMs: opts.pollMs,
        sleep: opts.sleep,
      });
      assertDelivered(status, d);
      return {
        output: {
          state: status.state,
          solanaAmount: status.amountOut!.toString(),
          solanaTx: status.destinationTxs[0] ?? "",
          tronTx: status.originTxs[0] ?? "",
          correlationId: status.correlationId ?? "",
        },
        bookings: [],
      };
    },
  };
}

/**
 * Tron's USDT has 6 decimals; the ledger's USDT has 7, which is Stellar's
 * precision. These amounts come straight off the solver network and never
 * reach the books, so they are formatted at the source's own scale rather
 * than passed through `money`, which would read them as ten times too small.
 */
const TRON_USDT_DECIMALS = 6n;

function tronUsdt(units: bigint): string {
  const scale = 10n ** TRON_USDT_DECIMALS;
  return `${units / scale}.${(units % scale).toString().padStart(Number(TRON_USDT_DECIMALS), "0")}`;
}

/**
 * Turn a terminal swap state into the right kind of failure.
 *
 * The distinction that matters is who still has the money. A refund means the
 * user does, on Tron, and the deposit is simply over — retrying would quote
 * again at a new rate against funds that are no longer there. A short deposit
 * means the solver is holding it, filling nothing and refunding nothing, so
 * only a human can decide. Exported because that mapping is the lane's real
 * logic, and it is worth testing without a solver.
 */
export function assertDelivered(status: SwapStatus, d: Pick<TronDepositData, "refundTo" | "depositAddress">): void {
  switch (status.state) {
    case "SUCCESS":
      if (status.amountOut === undefined) {
        throw new ManualReviewError(`the swap at ${d.depositAddress} reports SUCCESS without an amount`);
      }
      if (status.destinationTxs.length === 0) {
        throw new ManualReviewError(`the swap at ${d.depositAddress} reports SUCCESS without a Solana payout`);
      }
      return;
    case "REFUNDED": {
      const amount = status.refundedAmount !== undefined ? ` (${tronUsdt(status.refundedAmount)} USDT)` : "";
      throw new NonRetryableError(`the swap was refunded to ${d.refundTo} on Tron${amount}; the deposit is over`);
    }
    case "FAILED":
      throw new NonRetryableError(`the solver network could not fill the swap at ${d.depositAddress}`);
    case "INCOMPLETE_DEPOSIT":
      throw new ManualReviewError(
        `less arrived at ${d.depositAddress} than the quote priced; the solver is holding it without filling or refunding`,
      );
    default:
      // waitForSwap only returns terminal states, so this is a 1Click state
      // Corridor has not been taught — worth a human rather than a guess.
      throw new ManualReviewError(`the swap at ${d.depositAddress} is in an unrecognised state: ${status.state}`);
  }
}

const BURN_SCHEMA = `
create table if not exists tron_burns (
  deposit_address text primary key,
  idempotency_key text not null,
  burn_tx         text,
  submitted_at    timestamptz not null default now()
);
`;

/**
 * Remembers that a burn was submitted, before anyone knows whether it
 * landed.
 *
 * Keyed by the solver's deposit address, because that is what identifies the
 * deposit: one swap delivers once, so it is burned once. Keying on the saga
 * step instead would let a second saga started over the same deposit burn
 * again — the mistake the CCTP mint store was changed to avoid.
 */
export class TronBurnStore {
  private constructor(private readonly db: Db) {}

  static async open(db: Db): Promise<TronBurnStore> {
    await db.exec(BURN_SCHEMA);
    return new TronBurnStore(db);
  }

  async claim(depositAddress: string, key: string): Promise<void> {
    await this.db.query(`insert into tron_burns (deposit_address, idempotency_key) values ($1,$2) on conflict do nothing`, [
      depositAddress,
      key,
    ]);
  }

  async recordSubmitted(depositAddress: string, burnTx: string): Promise<void> {
    await this.db.query(`update tron_burns set burn_tx = $2 where deposit_address = $1`, [depositAddress, burnTx]);
  }

  async submitted(depositAddress: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ burn_tx: string | null }>(
      `select burn_tx from tron_burns where deposit_address = $1`,
      [depositAddress],
    );
    return rows[0]?.burn_tx ?? undefined;
  }
}

export interface TronBurnLegOptions {
  network: CctpNetwork;
  burns: TronBurnStore;
  usdcMint: Address;
  /**
   * Corridor's Solana fee payer. It pays the SOL the burn costs and signs as
   * payer only — it is never the owner, so it cannot move the USDC. A Solana
   * address derived from a Stellar key starts with no SOL, which is the whole
   * reason this is sponsored.
   */
  feePayer: TransactionSigner;
  /**
   * The user's Solana signer for their own account: the same Ed25519 key as
   * their Stellar account, supplied by the app's wallet. Corridor holds it
   * only for as long as the burn takes to sign.
   */
  ownerFor: (stellarAccount: string) => Promise<TransactionSigner>;
  /** Signs and submits the instruction. The Solana vault, in production. */
  submit: (instruction: Instruction) => Promise<string>;
  /** A fresh account per burn, which the CCTP program writes the message to. */
  eventAccount?: () => Promise<TransactionSigner>;
}

/** The USDC the swap actually delivered, read off the swap step's output. */
function deliveredUsdc(outputs: Record<number, Json>): bigint {
  for (const out of Object.values(outputs) as ({ solanaAmount?: string } | null)[]) {
    if (out?.solanaAmount) return BigInt(out.solanaAmount);
  }
  throw new NonRetryableError("tron.burn runs after tron.swap, and burns the amount that step recorded as delivered");
}

/**
 * The `tron.burn` leg: burn the swapped USDC on Solana so CCTP mints it on
 * the hub.
 *
 * The amount burned is what the solver actually delivered, not what the
 * quote predicted — slippage is real and burning more than arrived would
 * simply fail. The owner is the user; Corridor is only the fee payer. Like
 * the mint, nothing is booked here: the hub credit is booked by
 * `cctp.transfer`, from the burn this leg produces.
 */
export function tronBurnLeg(opts: TronBurnLegOptions): Leg<TronDepositData> {
  return {
    kind: "tron.burn",
    maxAttempts: 3,
    backoffMs: 5_000,
    async forward(ctx) {
      const d = ctx.data;
      const amount = deliveredUsdc(ctx.outputs);

      await opts.burns.claim(d.depositAddress, ctx.idempotencyKey);
      const already = await opts.burns.submitted(d.depositAddress);
      if (already) {
        // CCTP is nonce-replay-protected on-chain, so a resubmission cannot
        // burn twice — but the user's USDC is already gone, and re-signing
        // would only produce a second failure. The recorded hash is what the
        // mint leg needs.
        return { output: { burnTx: already, amount: amount.toString(), resubmitted: false }, bookings: [] };
      }

      const instruction = await buildBurnToStellar({
        payer: opts.feePayer,
        owner: await opts.ownerFor(d.stellarAccount),
        usdcMint: opts.usdcMint,
        messageSentEventAccount: await (opts.eventAccount ?? generateKeyPairSigner)(),
        amount,
        recipient: d.stellarAccount,
        network: opts.network,
      });
      const burnTx = await opts.submit(instruction);
      await opts.burns.recordSubmitted(d.depositAddress, burnTx);
      return { output: { burnTx, amount: amount.toString(), resubmitted: false }, bookings: [] };
    },
  };
}
