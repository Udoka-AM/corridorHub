import { money, type Asset, type Hex } from "@corridor/core";
import { pathPaymentWithReference, strictSendQuote, type StellarClient } from "@corridor/chain-stellar";
import { NonRetryableError, type Json, type Leg, type LegContext } from "@corridor/saga";

/**
 * `stellar.pathPayment`: on-ledger FX between two issued assets, on Stellar's
 * own order books.
 *
 * This is how a treasury holding EURC or MGUSD turns it into the settlement
 * asset without an external venue — the conversion lands in the same chain
 * history as everything else and books from it (ADR 0010).
 *
 * The price comes from Horizon and the leg will not accept worse than the
 * caller's slippage bound: `destMin` is set from the quote, so the
 * transaction fails rather than delivering less.
 */

export interface FxData {
  [k: string]: Json | undefined;
  /**
   * Exactly how much of the source asset to spend, in its minor units.
   *
   * Optional inside a payout route, where every leg shares one data object:
   * the amount to convert is then the balance the reserve leg held, which is
   * `amount`.
   */
  sourceAmount?: string;
  /** A payout's reserved balance, when this runs as a step of one. */
  amount?: string;
  reference: Hex;
  /** Vault being converted. Defaults to the treasury. */
  vault?: string;
  /** Horizon paging token to scan from when looking for work already done. */
  stellarCursor?: string;
}

export interface FxLegOptions {
  treasury: StellarClient;
  /** How much worse than the quote is acceptable, in basis points. Default 50 (0.5%). */
  maxSlippageBps?: number;
}

export function stellarPathPaymentLeg(opts: FxLegOptions): Leg<FxData> {
  const bps = BigInt(opts.maxSlippageBps ?? 50);
  return {
    kind: "stellar.pathPayment",
    maxAttempts: 3,
    backoffMs: 2_000,
    async forward(ctx: LegContext<FxData>) {
      const from = ctx.step.from.asset;
      const to = ctx.step.to.asset;
      if (from === to) throw new NonRetryableError("a path payment converts between two different assets");
      const source = ctx.data.sourceAmount ?? ctx.data.amount;
      if (!source) throw new NonRetryableError("a path payment needs sourceAmount, or an amount to convert");
      const sourceAmount = BigInt(source);
      const client = opts.treasury;

      const quote = await strictSendQuote(client, { from, sourceAmount, destAsset: to });
      if (!quote) throw new NonRetryableError(`no ${from} → ${to} path on Stellar for ${sourceAmount}`);
      const destMin = (quote.destAmount * (10_000n - bps)) / 10_000n;

      const move = await pathPaymentWithReference(client, {
        from,
        sourceAmount,
        destAsset: to,
        destMin,
        path: quote.path,
        reference: ctx.data.reference,
      });

      const a = ctx.accounts;
      const vaultName = ctx.data.vault ?? "treasury";
      const sourceVault = await a.vault(vaultName, from, "stellar");
      const destVault = await a.vault(vaultName, to, "stellar");
      // One clearing account per pair: a conversion nets to zero over time,
      // and what does not net is the spread, which is visible there.
      const pair = `${from}-${to}`;
      const sourceClearing = await a.clearing(pair, from, "stellar");
      const destClearing = await a.clearing(pair, to, "stellar");

      return {
        output: {
          move: move.externalRef,
          sourceAmount: sourceAmount.toString(),
          // `received` is what a following leg spends; the payout leg reads it.
          received: move.amount.toString(),
          quoted: quote.destAmount.toString(),
          destMin: destMin.toString(),
          fee: "0",
          path: quote.path.join(">"),
        },
        bookings: [
          {
            kind: "stellar.pathPayment",
            reference: ctx.data.reference,
            sagaId: ctx.sagaId,
            external: { venue: "stellar", ref: move.externalRef },
            metadata: { from, to, quoted: quote.destAmount.toString(), destMin: destMin.toString() },
            lines: [
              { account: sourceClearing, direction: "D", money: money(from as Asset, sourceAmount) },
              { account: sourceVault, direction: "C", money: money(from as Asset, sourceAmount) },
              { account: destVault, direction: "D", money: money(to as Asset, move.amount) },
              { account: destClearing, direction: "C", money: money(to as Asset, move.amount) },
            ],
          },
        ],
      };
    },
  };
}
