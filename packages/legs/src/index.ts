import type { Address } from "viem";
import { isFiat, money, type Fiat, type Hex, type Observation } from "@corridor/core";
import { findTransfersByReference, transferWithReference, type TempoClient } from "@corridor/chain-tempo";
import type { Accounts } from "@corridor/ledger";
import type { PartnerChain, PartnerOrder, PartnerRegistry, RampPartner } from "@corridor/partners";
import {
  ManualReviewError,
  NonRetryableError,
  amountOf,
  referenceFor,
  type Json,
  type Leg,
  type LegContext,
  type PayoutData,
} from "@corridor/saga";
import type { PartnerEventStore } from "@corridor/webhooks";

export { ledgerReserveLeg } from "@corridor/saga";

/** Saga data for a collection: local currency collected into the customer's hub balance. */
export interface CollectionData {
  [k: string]: Json | undefined;
  collectionId: string;
  customerId: string;
  corridor: `${Fiat}-${Fiat}`;
  currency: Fiat;
  /** Local currency the payer transfers, in minor units. */
  fiatAmount: string;
  reference: Hex;
  tempoStartBlock?: string;
}

type FlowData = PayoutData | CollectionData;

/**
 * The USDC/pathUSD amount a leg moves: fixed up front for payouts; for
 * collections it is only known once the partner has priced the order, so it
 * is read from the collect step's output.
 */
function flowAmount(ctx: LegContext<FlowData>): bigint {
  if ("amount" in ctx.data && ctx.data.amount) return BigInt(ctx.data.amount as string);
  for (const out of Object.values(ctx.outputs)) {
    const usdc = (out as { usdcAmount?: string } | null)?.usdcAmount;
    if (usdc) return BigInt(usdc);
  }
  throw new NonRetryableError("flow amount unknown: no fixed amount and no priced collection");
}

const sinceBlock = (ctx: LegContext<FlowData>) => BigInt(ctx.data.tempoStartBlock ?? "0");

/**
 * Move pathUSD on Tempo with the leg's Corridor Reference, unless an
 * identical movement (same memo, parties and amount) already landed. That
 * makes the leg safe to retry after a crash between send and bookkeeping.
 */
async function tempoMoveOnce(
  client: TempoClient,
  args: { to: Address; amount: bigint; reference: Hex; sinceBlock: bigint },
): Promise<Observation> {
  const existing = await findTransfersByReference(client, { asset: "pathUSD", reference: args.reference, fromBlock: args.sinceBlock });
  const from = client.account.address.toLowerCase();
  const done = existing.find(
    (o) => o.from?.toLowerCase() === from && o.to?.toLowerCase() === args.to.toLowerCase() && o.amount === args.amount,
  );
  if (done) return done;
  return transferWithReference(client, { asset: "pathUSD", to: args.to, amount: args.amount, reference: args.reference });
}

async function pegAccounts(a: Accounts) {
  return {
    treasury: await a.vault("treasury", "pathUSD", "tempo"),
    pegTempo: await a.clearing("usd-peg", "pathUSD", "tempo"),
    pegSolana: await a.clearing("usd-peg", "USDC", "solana"),
    solanaEgress: await a.vault("solana-egress", "USDC", "solana"),
    solanaIngress: await a.vault("solana-ingress", "USDC", "solana"),
  };
}

/**
 * Bridge leg for testnet, where Across has no Tempo deployment, in both directions.
 * The Tempo side is real: pathUSD moves between the treasury vault and an escrow
 * standing in for the Across SpokePool, carrying the flow's Corridor Reference.
 * The Solana side is simulated. `across.bridge` replaces it on mainnet with the
 * same bookings.
 */
export function simulatedBridgeLeg(opts: { treasury: TempoClient; escrow: TempoClient }): Leg<FlowData> {
  const outbound = (ctx: LegContext<FlowData>) => ctx.step.from.venue === "tempo";
  return {
    kind: "bridge.simulated",
    backoffMs: 1_000,
    async forward(ctx) {
      const amount = flowAmount(ctx);
      const reference = referenceFor(ctx as LegContext<PayoutData>);
      const [from, to] = outbound(ctx) ? [opts.treasury, opts.escrow] : [opts.escrow, opts.treasury];
      const move = await tempoMoveOnce(from, { to: to.account.address, amount, reference, sinceBlock: sinceBlock(ctx) });
      const acct = await pegAccounts(ctx.accounts);
      const tempoLine = (debit: string, credit: string) => [
        { account: debit, direction: "D" as const, money: money("pathUSD", amount) },
        { account: credit, direction: "C" as const, money: money("pathUSD", amount) },
      ];
      const usdcLine = (debit: string, credit: string) => [
        { account: debit, direction: "D" as const, money: money("USDC", amount) },
        { account: credit, direction: "C" as const, money: money("USDC", amount) },
      ];
      const tempoEntry = {
        kind: outbound(ctx) ? "bridge.deposit" : "bridge.fill",
        reference: ctx.data.reference,
        sagaId: ctx.sagaId,
        external: { venue: "tempo" as const, ref: move.externalRef },
        lines: outbound(ctx) ? tempoLine(acct.pegTempo, acct.treasury) : tempoLine(acct.treasury, acct.pegTempo),
      };
      const solanaEntry = {
        kind: outbound(ctx) ? "bridge.fill" : "bridge.deposit",
        reference: ctx.data.reference,
        sagaId: ctx.sagaId,
        external: { venue: "solana" as const, ref: `sim:${ctx.idempotencyKey}` },
        metadata: { simulated: true },
        lines: outbound(ctx) ? usdcLine(acct.solanaEgress, acct.pegSolana) : usdcLine(acct.pegSolana, acct.solanaIngress),
      };
      return {
        output: { tempoMove: move.externalRef, direction: outbound(ctx) ? "out" : "in", amount: amount.toString(), fill: "simulated" },
        bookings: outbound(ctx) ? [tempoEntry, solanaEntry] : [solanaEntry, tempoEntry],
      };
    },

    async compensate(ctx) {
      const amount = flowAmount(ctx);
      const reference = referenceFor(ctx as LegContext<PayoutData>);
      const [from, to] = outbound(ctx) ? [opts.escrow, opts.treasury] : [opts.treasury, opts.escrow];
      const refund = await tempoMoveOnce(from, { to: to.account.address, amount, reference, sinceBlock: sinceBlock(ctx) });
      const acct = await pegAccounts(ctx.accounts);
      const pair = (asset: "pathUSD" | "USDC", debit: string, credit: string) => [
        { account: debit, direction: "D" as const, money: money(asset, amount) },
        { account: credit, direction: "C" as const, money: money(asset, amount) },
      ];
      return {
        output: { tempoRefund: refund.externalRef },
        bookings: [
          {
            kind: "bridge.unfill",
            reference: ctx.data.reference,
            sagaId: ctx.sagaId,
            external: { venue: "solana", ref: `sim:${ctx.idempotencyKey}:compensate` },
            metadata: { simulated: true },
            lines: outbound(ctx) ? pair("USDC", acct.pegSolana, acct.solanaEgress) : pair("USDC", acct.solanaIngress, acct.pegSolana),
          },
          {
            kind: "bridge.refund",
            reference: ctx.data.reference,
            sagaId: ctx.sagaId,
            external: { venue: "tempo", ref: refund.externalRef },
            lines: outbound(ctx) ? pair("pathUSD", acct.treasury, acct.pegTempo) : pair("pathUSD", acct.pegTempo, acct.treasury),
          },
        ],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Ramp partner legs (the spokes)
// ---------------------------------------------------------------------------

export interface PartnerLegOptions {
  partners: PartnerRegistry;
  events: PartnerEventStore;
  /**
   * Send USDC from Corridor's egress vault on `chain` to a partner's one-off
   * funding address, with the Corridor Reference as memo. Returns the chain ref.
   */
  fund?: (args: { chain: PartnerChain; to: string; usdcAmount: bigint; reference: Hex; order: PartnerOrder }) => Promise<string>;
  /** Corridor wallet on `chain` that receives collected USDC. */
  ingressAddress?: (chain: PartnerChain) => string;
  /** Called when a collection is open, e.g. to send the virtual account to the customer. */
  onCollectionOpened?: (order: PartnerOrder) => Promise<void>;
  webhookUrl?: string;
  timeoutMs?: number;
  pollMs?: number;
}

const CHAIN: Record<string, PartnerChain> = { solana: "SOLANA", base: "BASE" };

async function waitForOrder(partner: RampPartner, events: PartnerEventStore, id: string, opts: PartnerLegOptions): Promise<PartnerOrder> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  while (true) {
    const pushed = await events.latest(partner.id, id);
    const order = await partner.getOrder(id);
    const status = pushed === "completed" || pushed === "failed" ? pushed : order.status;
    if (status === "completed" || status === "failed") return { ...order, status };
    if (Date.now() > deadline) throw new Error(`partner order ${id} still ${status} after timeout`);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 3_000));
  }
}

/**
 * Payout spoke: open an offramp order with the partner, fund it exactly once
 * from the egress vault, and wait for the partner to pay the beneficiary.
 */
export function partnerPayoutLeg(opts: PartnerLegOptions): Leg<PayoutData> {
  return {
    kind: "partner.payout",
    maxAttempts: 3,
    async forward(ctx) {
      const d = ctx.data;
      const chain = CHAIN[ctx.step.from.venue];
      const currency = ctx.step.to.asset;
      if (!chain || !isFiat(currency)) throw new NonRetryableError(`partner.payout needs a chain venue and a fiat target, got ${ctx.step.from.venue} → ${currency}`);
      const r = d.recipient as { kind?: string; bankCode?: string; accountNumber?: string };
      if (r.kind !== "bank" || !r.bankCode || !r.accountNumber) throw new NonRetryableError("payout recipient needs bankCode and accountNumber");
      const partner = opts.partners.forPayout(currency, chain);
      const usdc = BigInt(d.amount);

      // Exactly-once: reuse the order this step already opened (and funded) if any.
      let link = await opts.events.linkedOrder(ctx.idempotencyKey);
      if (!link) {
        const order = await partner.openPayout({
          currency,
          chain,
          usdcAmount: usdc,
          beneficiary: { bankCode: r.bankCode, accountNumber: r.accountNumber },
          reference: d.reference,
          webhookUrl: opts.webhookUrl,
        });
        await opts.events.record(order);
        await opts.events.linkOrder(ctx.idempotencyKey, partner.id, order.id, order.fundingAddress);
        link = await opts.events.linkedOrder(ctx.idempotencyKey);
      }
      if (!link!.fundingRef) {
        const order = await partner.getOrder(link!.orderId);
        if (order.status === "failed") throw new Error(`partner rejected order ${order.id} before funding`);
        if (!opts.fund) throw new NonRetryableError("no funding function configured for partner payouts");
        const fundingRef = await opts.fund({ chain, to: link!.fundingAddress!, usdcAmount: usdc, reference: d.reference, order });
        await opts.events.markFunded(ctx.idempotencyKey, fundingRef);
        link = { ...link!, fundingRef };
      }

      const done = await waitForOrder(partner, opts.events, link!.orderId, opts);
      if (done.status === "failed") {
        // Money already left the egress vault: a human confirms the partner's refund before anything is undone.
        throw new ManualReviewError(`partner ${partner.id} failed order ${done.id} after it was funded (${link!.fundingRef})`);
      }

      const a = ctx.accounts;
      const hold = await a.customerHold(d.customerId, d.corridor, d.asset, d.venue);
      const pegTempo = await a.clearing("usd-peg", "pathUSD", "tempo");
      const pegSolana = await a.clearing("usd-peg", "USDC", "solana");
      const egress = await a.vault("solana-egress", "USDC", "solana");
      return {
        output: {
          partner: partner.id,
          orderId: done.id,
          fundingRef: link!.fundingRef!,
          fiatAmount: done.fiatAmount.toString(),
          currency,
          rate: done.rate,
          status: done.status,
        },
        bookings: [
          {
            kind: "partner.payout",
            reference: d.reference,
            sagaId: ctx.sagaId,
            external: { venue: "partner_fiat", ref: `${partner.id}:${done.id}` },
            metadata: { currency, fiatAmount: done.fiatAmount.toString(), rate: done.rate, fundingRef: link!.fundingRef! },
            lines: [
              { account: hold, direction: "D", money: amountOf(d) },
              { account: pegTempo, direction: "C", money: amountOf(d) },
              { account: pegSolana, direction: "D", money: money("USDC", usdc) },
              { account: egress, direction: "C", money: money("USDC", usdc) },
            ],
          },
        ],
      };
    },
  };
}

/**
 * Collection spoke: open an onramp order so the payer can pay local currency
 * into a one-off virtual account, then wait for the partner to deliver USDC
 * to Corridor's ingress wallet.
 */
export function partnerCollectLeg(opts: PartnerLegOptions): Leg<CollectionData> {
  return {
    kind: "partner.collect",
    maxAttempts: 3,
    async forward(ctx) {
      const d = ctx.data;
      const chain = CHAIN[ctx.step.to.venue];
      if (!chain) throw new NonRetryableError(`partner.collect must deliver to a chain venue, got ${ctx.step.to.venue}`);
      if (!opts.ingressAddress) throw new NonRetryableError("no ingress address configured for collections");
      const partner = opts.partners.forCollection(d.currency, chain);

      let link = await opts.events.linkedOrder(ctx.idempotencyKey);
      if (!link) {
        const order = await partner.openCollection({
          currency: d.currency,
          chain,
          fiatAmount: BigInt(d.fiatAmount),
          recipient: opts.ingressAddress(chain),
          reference: d.reference,
          webhookUrl: opts.webhookUrl,
        });
        await opts.events.record(order);
        await opts.events.linkOrder(ctx.idempotencyKey, partner.id, order.id);
        await opts.onCollectionOpened?.(order);
        link = await opts.events.linkedOrder(ctx.idempotencyKey);
      }

      const done = await waitForOrder(partner, opts.events, link!.orderId, opts);
      if (done.status === "failed") throw new NonRetryableError(`collection ${done.id} failed at ${partner.id}`);

      const a = ctx.accounts;
      const ingress = await a.vault("solana-ingress", "USDC", "solana");
      const pegSolana = await a.clearing("usd-peg", "USDC", "solana");
      return {
        output: {
          partner: partner.id,
          orderId: done.id,
          usdcAmount: done.usdcAmount.toString(),
          fiatAmount: done.fiatAmount.toString(),
          currency: d.currency,
          rate: done.rate,
          deliveryRef: done.txSignature ?? null,
        },
        bookings: [
          {
            kind: "partner.collect",
            reference: d.reference,
            sagaId: ctx.sagaId,
            external: { venue: "partner_fiat", ref: `${partner.id}:${done.id}` },
            metadata: { currency: d.currency, fiatAmount: done.fiatAmount.toString(), rate: done.rate },
            lines: [
              { account: ingress, direction: "D", money: money("USDC", done.usdcAmount) },
              { account: pegSolana, direction: "C", money: money("USDC", done.usdcAmount) },
            ],
          },
        ],
      };
    },
  };
}

/** Last step of a collection: credit the customer's pathUSD balance on the Tempo hub. */
export const ledgerCreditLeg: Leg<CollectionData> = {
  kind: "ledger.credit",
  maxAttempts: 1,
  async forward(ctx) {
    const d = ctx.data;
    const amount = flowAmount(ctx);
    const pegTempo = await ctx.accounts.clearing("usd-peg", "pathUSD", "tempo");
    const customer = await ctx.accounts.customer(d.customerId, d.corridor, "pathUSD", "tempo");
    return {
      output: { credited: amount.toString() },
      bookings: [
        {
          kind: "collection.credit",
          reference: d.reference,
          sagaId: ctx.sagaId,
          lines: [
            { account: pegTempo, direction: "D", money: money("pathUSD", amount) },
            { account: customer, direction: "C", money: money("pathUSD", amount) },
          ],
        },
      ],
    };
  },
};
export * from "./shielded.ts";
