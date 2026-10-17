import { money, type Asset, type CorridorCode, type Hex, type Venue } from "@corridor/core";
import type { Json, Leg, LegContext } from "./engine.ts";

/** Saga data for a single payout (public) or a batch (shielded). JSON-safe: amounts are minor-unit strings. */
export interface PayoutData {
  [k: string]: Json | undefined;
  payoutId: string;
  customerId: string;
  corridor: CorridorCode;
  /** Settlement asset and venue the customer is debited in (USDC on Stellar). */
  asset: Asset;
  venue: Venue;
  amount: string;
  reference: Hex;
  /** Batch routes: the only reference allowed on public legs. */
  batchReference?: Hex;
  recipient: { [k: string]: Json };
  /** Horizon paging token the saga started at; legs scan from here to find work they already did. */
  stellarCursor?: string;
}

export const amountOf = (d: PayoutData) => money(d.asset, BigInt(d.amount));

/** The reference a leg may put on-chain, per the planner's reference scope. */
export function referenceFor(ctx: LegContext<PayoutData>): Hex {
  switch (ctx.step.referenceScope) {
    case "payout":
      return ctx.data.reference;
    case "batch":
      return ctx.data.batchReference ?? ctx.data.reference;
    case "item":
      throw new Error("item references are per recipient and only live in encrypted memos");
  }
}

/** Moves the customer's funds from available to held. Pure ledger; no chain movement. */
export const ledgerReserveLeg: Leg<PayoutData> = {
  kind: "ledger.reserve",
  maxAttempts: 1,
  async forward(ctx) {
    const d = ctx.data;
    const available = await ctx.accounts.customer(d.customerId, d.corridor, d.asset, d.venue);
    const hold = await ctx.accounts.customerHold(d.customerId, d.corridor, d.asset, d.venue);
    return {
      output: { held: d.amount },
      bookings: [
        {
          kind: "payout.reserve",
          reference: d.reference,
          sagaId: ctx.sagaId,
          lines: [
            { account: available, direction: "D", money: amountOf(d) },
            { account: hold, direction: "C", money: amountOf(d) },
          ],
        },
      ],
    };
  },
  async compensate(ctx) {
    const d = ctx.data;
    const available = await ctx.accounts.customer(d.customerId, d.corridor, d.asset, d.venue);
    const hold = await ctx.accounts.customerHold(d.customerId, d.corridor, d.asset, d.venue);
    return {
      output: { released: d.amount },
      bookings: [
        {
          kind: "payout.release",
          reference: d.reference,
          sagaId: ctx.sagaId,
          lines: [
            { account: hold, direction: "D", money: amountOf(d) },
            { account: available, direction: "C", money: amountOf(d) },
          ],
        },
      ],
    };
  },
};
