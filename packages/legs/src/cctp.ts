import { money, type Hex, type Venue } from "@corridor/core";
import {
  Iris,
  chainOfDomain,
  depositInstruction,
  encodeForwardHook,
  hubAmountOf,
  mintAndForward,
  receivedOnStellar,
  type CctpNetwork,
  type StellarMintOptions,
} from "@corridor/bridge-cctp";
import type { Db } from "@corridor/ledger";
import { NonRetryableError, type Json, type Leg, type LegContext } from "@corridor/saga";

/**
 * The `cctp.transfer` leg, inbound: USDC burned on a spoke arrives as
 * canonical USDC on the Stellar hub.
 *
 * Two recorded steps with a wait between them — burn, attestation, mint — so
 * it is the saga engine's shape rather than a bridge to trust. Corridor does
 * not perform the burn: on the way in the funds are the sender's, on the
 * sender's own chain, and `depositInstruction` is what tells them where to
 * send. This leg starts from the burn transaction they made.
 */

const SCHEMA = `
create table if not exists cctp_mints (
  burn_tx         text primary key,
  idempotency_key text not null,
  mint_tx         text,
  submitted_at    timestamptz not null default now()
);
`;

/**
 * Remembers that a mint was submitted, before anyone knows whether it
 * settled. CCTP is nonce-replay-protected on-chain, so a second attempt
 * fails rather than minting twice — but a failed retry is indistinguishable
 * from a genuine refusal, so the hash is written down first and checked
 * instead.
 *
 * Keyed by the **burn transaction**, not by the saga step. One burn can only
 * ever be minted once, and two sagas started over the same burn have
 * different step keys — so keying on the step would let the second one mint
 * and book again.
 */
export class CctpMintStore {
  private constructor(private readonly db: Db) {}

  static async open(db: Db): Promise<CctpMintStore> {
    await db.exec(SCHEMA);
    return new CctpMintStore(db);
  }

  async claim(burnTx: string, key: string): Promise<void> {
    await this.db.query(`insert into cctp_mints (burn_tx, idempotency_key) values ($1,$2) on conflict do nothing`, [burnTx, key]);
  }

  async recordSubmitted(burnTx: string, mintTx: string): Promise<void> {
    await this.db.query(`update cctp_mints set mint_tx = $2 where burn_tx = $1`, [burnTx, mintTx]);
  }

  async submitted(burnTx: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ mint_tx: string | null }>(`select mint_tx from cctp_mints where burn_tx = $1`, [burnTx]);
    return rows[0]?.mint_tx ?? undefined;
  }
}

/** Saga data for an inbound CCTP deposit. */
export interface CctpInboundData {
  [k: string]: Json | undefined;
  /** Circle's domain the burn happened on. */
  sourceDomain: number;
  /** The burn transaction on that chain. */
  burnTx: string;
  /** Amount burned, in the source chain's 6-decimal USDC units. */
  sourceAmount: string;
  /** The Stellar account the forwarder pays: a Corridor vault, or an app's user. */
  recipient: string;
  reference: Hex;
  /** Which vault the arriving USDC belongs to, for the books. */
  vault?: string;
  /**
   * Whose USDC was burned.
   *
   * `vault` is Corridor moving its own float off a spoke, so the spoke's
   * vault is drawn down. `external` is a sender funding the hub from their
   * own wallet — the Ramp case — where Corridor never held the money on the
   * spoke, so only the hub side moves and the other leg of the entry is an
   * inbound clearing account for reconciliation to assign. Defaults to
   * `external`, the safer of the two: it cannot draw down a vault that was
   * never funded.
   */
  source?: "vault" | "external";
}

export interface CctpLegOptions {
  iris: Iris;
  mints: CctpMintStore;
  network: CctpNetwork;
  /** Everything needed to sign and submit the mint on Stellar. */
  mint: Omit<StellarMintOptions, "network" | "onSubmitted">;
  timeoutMs?: number;
  pollMs?: number;
}

export function cctpTransferLeg(opts: CctpLegOptions): Leg<CctpInboundData> {
  return {
    kind: "cctp.transfer",
    maxAttempts: 5,
    backoffMs: 5_000,
    async forward(ctx) {
      const d = ctx.data;
      const spoke = ctx.step.from.venue;
      if (ctx.step.to.venue !== "stellar") {
        throw new NonRetryableError(`this cctp.transfer leg only receives on the hub, not ${ctx.step.to.venue}`);
      }
      // A domain Corridor does not know is a configuration error, not a retry.
      try {
        chainOfDomain(d.sourceDomain);
      } catch (e) {
        throw new NonRetryableError((e as Error).message);
      }

      const amount = hubAmountOf(BigInt(d.sourceAmount));
      const mintOpts: StellarMintOptions = { ...opts.mint, network: opts.network };

      // Has this burn already been minted, by this saga or another?
      await opts.mints.claim(d.burnTx, ctx.idempotencyKey);
      let mintTx = await opts.mints.submitted(d.burnTx);
      if (mintTx && !(await receivedOnStellar(mintTx, mintOpts))) {
        // Submitted but not successful: the message is still unminted, so the
        // nonce is free and it is safe to send again.
        mintTx = undefined;
      }

      if (!mintTx) {
        const attested = await opts.iris.waitForAttestation({
          sourceDomain: d.sourceDomain,
          transactionHash: d.burnTx,
          timeoutMs: opts.timeoutMs,
          pollMs: opts.pollMs,
        });
        const minted = await mintAndForward(attested, encodeForwardHook(d.recipient), {
          ...mintOpts,
          onSubmitted: (hash) => opts.mints.recordSubmitted(d.burnTx, hash),
        });
        mintTx = minted.txHash;
      }

      const a = ctx.accounts;
      const vault = await a.vault(d.vault ?? "treasury", "USDC", "stellar");
      const pair = (debit: string, credit: string) => [
        { account: debit, direction: "D" as const, money: money("USDC", amount) },
        { account: credit, direction: "C" as const, money: money("USDC", amount) },
      ];

      // The burn side only moves a vault when the vault is what funded it.
      const ownFloat = d.source === "vault";
      const burnCredit = ownFloat
        ? await a.vault(`${spoke}-ingress`, "USDC", spoke)
        : await a.clearing("cctp-inbound", "USDC", spoke);
      const pegSpoke = await a.clearing("usd-peg", "USDC", spoke);
      const pegHub = await a.clearing("usd-peg", "USDC", "stellar");

      return {
        output: { burnTx: d.burnTx, mintTx, amount: amount.toString(), recipient: d.recipient, source: d.source ?? "external" },
        bookings: [
          {
            // The burn: USDC left the spoke. Keyed by the burn transaction, so
            // the same burn can never be booked twice.
            kind: "cctp.burn",
            reference: d.reference,
            sagaId: ctx.sagaId,
            external: { venue: spoke as Venue, ref: d.burnTx },
            lines: pair(pegSpoke, burnCredit),
          },
          {
            kind: "cctp.mint",
            reference: d.reference,
            sagaId: ctx.sagaId,
            external: { venue: "stellar", ref: mintTx },
            metadata: { sourceDomain: String(d.sourceDomain), sourceAmount: d.sourceAmount, source: d.source ?? "external" },
            lines: pair(vault, pegHub),
          },
        ],
      };
    },
  };
}

/** Re-exported so an app or a script can hand out a deposit instruction without reaching past the legs. */
export { depositInstruction };
