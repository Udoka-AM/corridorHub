import type { Address } from "viem";
import { money, type Hex, type Observation } from "@corridor/core";
import { findTransfersByReference, transferWithReference, type TempoClient } from "@corridor/chain-tempo";
import { amountOf, referenceFor, type Leg, type LegContext, type PayoutData } from "@corridor/saga";

export { ledgerReserveLeg } from "@corridor/saga";

/**
 * Move pathUSD on Tempo with the leg's Corridor Reference, unless an
 * identical movement (same memo, parties and amount) already landed. That
 * makes the leg safe to retry after a crash between send and bookkeeping.
 */
async function tempoMoveOnce(
  client: TempoClient,
  args: { to: Address; amount: bigint; reference: Hex; sinceBlock: bigint },
): Promise<Observation> {
  const existing = await findTransfersByReference(client, {
    asset: "pathUSD",
    reference: args.reference,
    fromBlock: args.sinceBlock,
  });
  const from = client.account.address.toLowerCase();
  const done = existing.find(
    (o) => o.from?.toLowerCase() === from && o.to?.toLowerCase() === args.to.toLowerCase() && o.amount === args.amount,
  );
  if (done) return done;
  return transferWithReference(client, { asset: "pathUSD", to: args.to, amount: args.amount, reference: args.reference });
}

const sinceBlock = (ctx: LegContext<PayoutData>) => BigInt(ctx.data.tempoStartBlock ?? "0");

/**
 * Bridge leg for testnet, where Across has no Tempo deployment. The Tempo
 * side is real: pathUSD moves from the treasury vault into an escrow address
 * standing in for the Across SpokePool, with the payout reference as memo.
 * The Solana-side fill is simulated. `across.bridge` replaces this on mainnet
 * with the same bookings.
 */
export function simulatedBridgeLeg(opts: { treasury: TempoClient; escrow: TempoClient }): Leg<PayoutData> {
  return {
    kind: "bridge.simulated",
    backoffMs: 1_000,
    async forward(ctx) {
      const d = ctx.data;
      const reference = referenceFor(ctx);
      const deposit = await tempoMoveOnce(opts.treasury, {
        to: opts.escrow.account.address,
        amount: BigInt(d.amount),
        reference,
        sinceBlock: sinceBlock(ctx),
      });

      const a = ctx.accounts;
      const treasury = await a.vault("treasury", "pathUSD", "tempo");
      const pegTempo = await a.clearing("usd-peg", "pathUSD", "tempo");
      const pegSolana = await a.clearing("usd-peg", "USDC", "solana");
      const solanaEgress = await a.vault("solana-egress", "USDC", "solana");
      return {
        output: { tempoDeposit: deposit.externalRef, fill: "simulated" },
        bookings: [
          {
            kind: "bridge.deposit",
            reference: d.reference,
            sagaId: ctx.sagaId,
            external: { venue: "tempo", ref: deposit.externalRef },
            lines: [
              { account: pegTempo, direction: "D", money: amountOf(d) },
              { account: treasury, direction: "C", money: amountOf(d) },
            ],
          },
          {
            kind: "bridge.fill",
            reference: d.reference,
            sagaId: ctx.sagaId,
            external: { venue: "solana", ref: `sim:${ctx.idempotencyKey}` },
            metadata: { simulated: true },
            lines: [
              { account: solanaEgress, direction: "D", money: money("USDC", BigInt(d.amount)) },
              { account: pegSolana, direction: "C", money: money("USDC", BigInt(d.amount)) },
            ],
          },
        ],
      };
    },

    async compensate(ctx) {
      const d = ctx.data;
      const reference = referenceFor(ctx);
      const refund = await tempoMoveOnce(opts.escrow, {
        to: opts.treasury.account.address,
        amount: BigInt(d.amount),
        reference,
        sinceBlock: sinceBlock(ctx),
      });

      const a = ctx.accounts;
      const treasury = await a.vault("treasury", "pathUSD", "tempo");
      const pegTempo = await a.clearing("usd-peg", "pathUSD", "tempo");
      const pegSolana = await a.clearing("usd-peg", "USDC", "solana");
      const solanaEgress = await a.vault("solana-egress", "USDC", "solana");
      return {
        output: { tempoRefund: refund.externalRef },
        bookings: [
          {
            kind: "bridge.unfill",
            reference: d.reference,
            sagaId: ctx.sagaId,
            external: { venue: "solana", ref: `sim:${ctx.idempotencyKey}:compensate` },
            metadata: { simulated: true },
            lines: [
              { account: pegSolana, direction: "D", money: money("USDC", BigInt(d.amount)) },
              { account: solanaEgress, direction: "C", money: money("USDC", BigInt(d.amount)) },
            ],
          },
          {
            kind: "bridge.refund",
            reference: d.reference,
            sagaId: ctx.sagaId,
            external: { venue: "tempo", ref: refund.externalRef },
            lines: [
              { account: treasury, direction: "D", money: amountOf(d) },
              { account: pegTempo, direction: "C", money: amountOf(d) },
            ],
          },
        ],
      };
    },
  };
}

/**
 * Stand-in ramp partner until the Paj adapter lands (D4). Settles the
 * customer's hold against the USDC that left the Solana egress vault.
 */
export function mockPartnerLeg(): Leg<PayoutData> {
  return {
    kind: "partner.payout",
    async forward(ctx) {
      const d = ctx.data;
      const a = ctx.accounts;
      const hold = await a.customerHold(d.customerId, d.corridor, d.asset, d.venue);
      const pegTempo = await a.clearing("usd-peg", "pathUSD", "tempo");
      const pegSolana = await a.clearing("usd-peg", "USDC", "solana");
      const solanaEgress = await a.vault("solana-egress", "USDC", "solana");
      const partnerRef = `mock-${d.payoutId}`;
      return {
        output: { partner: "mock", partnerRef, status: "paid" },
        bookings: [
          {
            kind: "partner.payout",
            reference: d.reference,
            sagaId: ctx.sagaId,
            external: { venue: "partner_fiat", ref: partnerRef },
            metadata: { simulated: true, recipient: d.recipient },
            lines: [
              { account: hold, direction: "D", money: amountOf(d) },
              { account: pegTempo, direction: "C", money: amountOf(d) },
              { account: pegSolana, direction: "D", money: money("USDC", BigInt(d.amount)) },
              { account: solanaEgress, direction: "C", money: money("USDC", BigInt(d.amount)) },
            ],
          },
        ],
      };
    },
  };
}
