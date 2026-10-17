import { isFiat, money, rescale, type Asset, type Fiat, type Hex, type Observation, type Venue } from "@corridor/core";
import { findTransfersByReference, transferWithReference, type StellarClient } from "@corridor/chain-stellar";
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
  /** Horizon paging token the saga started at; legs scan from here to find work they already did. */
  stellarCursor?: string;
}

type FlowData = PayoutData | CollectionData;

/**
 * The USDC amount a leg moves: fixed up front for payouts; for collections it
 * is only known once the anchor has priced the order, so it is read from the
 * collect step's output.
 */
function flowAmount(ctx: LegContext<FlowData>): bigint {
  if ("amount" in ctx.data && ctx.data.amount) return BigInt(ctx.data.amount as string);
  for (const out of Object.values(ctx.outputs) as ({ usdcAmount?: string } | null)[]) {
    const usdc = out?.usdcAmount;
    if (usdc) return BigInt(usdc);
  }
  throw new NonRetryableError("flow amount unknown: no fixed amount and no priced collection");
}

const sinceCursor = (ctx: LegContext<FlowData>) => ctx.data.stellarCursor as string | undefined;

/**
 * Move an asset on Stellar with the leg's Corridor Reference as MEMO_HASH,
 * unless an identical movement (same memo, parties and amount) already
 * landed. That makes the leg safe to retry after a crash between submitting
 * the transaction and booking it.
 */
async function stellarMoveOnce(
  client: StellarClient,
  args: { asset: Asset; to: string; amount: bigint; reference: Hex; cursor?: string },
): Promise<Observation> {
  const from = client.address;
  const existing = await findTransfersByReference(client, { account: from, reference: args.reference, cursor: args.cursor });
  const done = existing.find((o) => o.from === from && o.to === args.to && o.amount === args.amount && o.asset === args.asset);
  if (done) return done;
  return transferWithReference(client, { asset: args.asset, to: args.to, amount: args.amount, reference: args.reference });
}

/**
 * Hub leg: pay an anchor (or any Stellar counterparty) out of the treasury
 * vault, carrying the flow's reference. This is the common payout path now
 * that anchors settle on Stellar itself — no bridge stands between the
 * customer's balance and the beneficiary's currency.
 */
export function stellarTransferLeg(opts: { treasury: StellarClient; to: (ctx: LegContext<FlowData>) => string }): Leg<FlowData> {
  return {
    kind: "stellar.transfer",
    backoffMs: 1_000,
    maxAttempts: 5,
    async forward(ctx) {
      const amount = flowAmount(ctx);
      const asset = ctx.step.to.asset;
      const reference = referenceFor(ctx as LegContext<PayoutData>);
      const move = await stellarMoveOnce(opts.treasury, { asset, to: opts.to(ctx), amount, reference, cursor: sinceCursor(ctx) });
      const treasury = await ctx.accounts.vault("treasury", asset, "stellar");
      const clearing = await ctx.accounts.clearing("stellar-transfer", asset, "stellar");
      return {
        output: { move: move.externalRef, amount: amount.toString() },
        bookings: [
          {
            kind: "stellar.transfer",
            reference: ctx.data.reference,
            sagaId: ctx.sagaId,
            external: { venue: "stellar", ref: move.externalRef },
            lines: [
              { account: clearing, direction: "D", money: money(asset, amount) },
              { account: treasury, direction: "C", money: money(asset, amount) },
            ],
          },
        ],
      };
    },
  };
}

async function pegAccounts(a: Accounts, spoke: Venue) {
  return {
    treasury: await a.vault("treasury", "USDC", "stellar"),
    pegHub: await a.clearing("usd-peg", "USDC", "stellar"),
    pegSpoke: await a.clearing("usd-peg", "USDC", spoke),
    egress: await a.vault(`${spoke}-egress`, "USDC", spoke),
    ingress: await a.vault(`${spoke}-ingress`, "USDC", spoke),
  };
}

/**
 * Bridge leg for testnet, where CCTP is not wired up, in both directions. The
 * Stellar side is real: USDC moves between the treasury vault and an escrow
 * standing in for the bridge, carrying the flow's Corridor Reference. The
 * far side is simulated. `cctp.transfer` replaces it on mainnet with the same
 * bookings.
 */
export function simulatedBridgeLeg(opts: { treasury: StellarClient; escrow: StellarClient }): Leg<FlowData> {
  const outbound = (ctx: LegContext<FlowData>) => ctx.step.from.venue === "stellar";
  const spokeOf = (ctx: LegContext<FlowData>) => (outbound(ctx) ? ctx.step.to.venue : ctx.step.from.venue);
  return {
    kind: "bridge.simulated",
    backoffMs: 1_000,
    async forward(ctx) {
      const amount = flowAmount(ctx);
      const reference = referenceFor(ctx as LegContext<PayoutData>);
      const [from, to] = outbound(ctx) ? [opts.treasury, opts.escrow] : [opts.escrow, opts.treasury];
      const move = await stellarMoveOnce(from, { asset: "USDC", to: to.address, amount, reference, cursor: sinceCursor(ctx) });
      const acct = await pegAccounts(ctx.accounts, spokeOf(ctx));
      const pair = (debit: string, credit: string) => [
        { account: debit, direction: "D" as const, money: money("USDC", amount) },
        { account: credit, direction: "C" as const, money: money("USDC", amount) },
      ];
      const hubEntry = {
        kind: outbound(ctx) ? "bridge.deposit" : "bridge.fill",
        reference: ctx.data.reference,
        sagaId: ctx.sagaId,
        external: { venue: "stellar" as const, ref: move.externalRef },
        lines: outbound(ctx) ? pair(acct.pegHub, acct.treasury) : pair(acct.treasury, acct.pegHub),
      };
      const spokeEntry = {
        kind: outbound(ctx) ? "bridge.fill" : "bridge.deposit",
        reference: ctx.data.reference,
        sagaId: ctx.sagaId,
        external: { venue: spokeOf(ctx), ref: `sim:${ctx.idempotencyKey}` },
        metadata: { simulated: true },
        lines: outbound(ctx) ? pair(acct.egress, acct.pegSpoke) : pair(acct.pegSpoke, acct.ingress),
      };
      return {
        output: { stellarMove: move.externalRef, direction: outbound(ctx) ? "out" : "in", amount: amount.toString(), fill: "simulated" },
        bookings: outbound(ctx) ? [hubEntry, spokeEntry] : [spokeEntry, hubEntry],
      };
    },

    async compensate(ctx) {
      const amount = flowAmount(ctx);
      const reference = referenceFor(ctx as LegContext<PayoutData>);
      const [from, to] = outbound(ctx) ? [opts.escrow, opts.treasury] : [opts.treasury, opts.escrow];
      const refund = await stellarMoveOnce(from, { asset: "USDC", to: to.address, amount, reference, cursor: sinceCursor(ctx) });
      const acct = await pegAccounts(ctx.accounts, spokeOf(ctx));
      const pair = (debit: string, credit: string) => [
        { account: debit, direction: "D" as const, money: money("USDC", amount) },
        { account: credit, direction: "C" as const, money: money("USDC", amount) },
      ];
      return {
        output: { stellarRefund: refund.externalRef },
        bookings: [
          {
            kind: "bridge.unfill",
            reference: ctx.data.reference,
            sagaId: ctx.sagaId,
            external: { venue: spokeOf(ctx), ref: `sim:${ctx.idempotencyKey}:compensate` },
            metadata: { simulated: true },
            lines: outbound(ctx) ? pair(acct.pegSpoke, acct.egress) : pair(acct.ingress, acct.pegSpoke),
          },
          {
            kind: "bridge.refund",
            reference: ctx.data.reference,
            sagaId: ctx.sagaId,
            external: { venue: "stellar", ref: refund.externalRef },
            lines: outbound(ctx) ? pair(acct.treasury, acct.pegHub) : pair(acct.pegHub, acct.treasury),
          },
        ],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Anchor legs (the spokes)
// ---------------------------------------------------------------------------

export interface PartnerLegOptions {
  partners: PartnerRegistry;
  events: PartnerEventStore;
  /**
   * Send USDC from Corridor's egress vault on `chain` to the anchor's
   * one-off funding address, with the Corridor Reference as memo. Returns the
   * chain ref.
   */
  fund?: (args: { chain: PartnerChain; to: string; usdcAmount: bigint; reference: Hex; order: PartnerOrder }) => Promise<string>;
  /** Corridor wallet on `chain` that receives collected USDC. */
  ingressAddress?: (chain: PartnerChain) => string;
  /** Called when a collection is open, e.g. to send the deposit instructions to the customer. */
  onCollectionOpened?: (order: PartnerOrder) => Promise<void>;
  webhookUrl?: string;
  timeoutMs?: number;
  pollMs?: number;
}

const CHAIN: Record<string, PartnerChain> = { stellar: "STELLAR", solana: "SOLANA", base: "BASE" };

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
 * Payout spoke: open an offramp order with the anchor, fund it exactly once
 * from the egress vault, and wait for the anchor to pay the beneficiary.
 *
 * The egress vault is on whichever venue the anchor settles on. A Stellar
 * anchor is funded straight from the hub; one that settles elsewhere is
 * funded after a bridge hop, and the customer bears those fees.
 */
export function partnerPayoutLeg(opts: PartnerLegOptions): Leg<PayoutData> {
  return {
    kind: "partner.payout",
    maxAttempts: 3,
    async forward(ctx) {
      const d = ctx.data;
      const spoke = ctx.step.from.venue;
      const chain = CHAIN[spoke];
      const currency = ctx.step.to.asset;
      if (!chain || !isFiat(currency)) {
        throw new NonRetryableError(`partner.payout needs a chain venue and a fiat target, got ${spoke} → ${currency}`);
      }
      const r = d.recipient as { kind?: string; bankCode?: string; accountNumber?: string };
      if (r.kind !== "bank" || !r.bankCode || !r.accountNumber) throw new NonRetryableError("payout recipient needs bankCode and accountNumber");
      const partner = opts.partners.forPayout(currency, chain);
      // What reached the egress vault: the payout amount when the anchor is on
      // the hub, less bridge fees when it is not.
      const bridged = Object.values(ctx.outputs).filter((o): o is { received: string; fee: string } => !!(o as { received?: string } | null)?.received);
      const usdc = bridged.length ? BigInt(bridged.at(-1)!.received) : BigInt(d.amount);
      const bridgeFees = bridged.reduce((s, o) => s + BigInt(o.fee), 0n);

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
        // Anchors may round the order: fund exactly what the order asks for.
        const fundingRef = await opts.fund({ chain, to: link!.fundingAddress!, usdcAmount: order.usdcAmount || usdc, reference: d.reference, order });
        await opts.events.markFunded(ctx.idempotencyKey, fundingRef);
        link = { ...link!, fundingRef };
      }

      const done = await waitForOrder(partner, opts.events, link!.orderId, opts);
      if (done.status === "failed") {
        // Money already left the egress vault: a human confirms the anchor's refund before anything is undone.
        throw new ManualReviewError(`partner ${partner.id} failed order ${done.id} after it was funded (${link!.fundingRef})`);
      }

      const a = ctx.accounts;
      const hold = await a.customerHold(d.customerId, d.corridor, d.asset, d.venue);
      const egress = await a.vault(`${spoke}-egress`, "USDC", spoke);
      const paid = done.usdcAmount > 0n ? done.usdcAmount : usdc;
      const total = BigInt(d.amount);
      // Anything the anchor's rounding left in the egress vault is dust held for the customer.
      const dust = total - paid - bridgeFees;
      if (dust < 0n) throw new ManualReviewError(`partner ${partner.id} took ${paid} for a ${total} payout after ${bridgeFees} in bridge fees`);
      const recovery = bridgeFees > 0n ? await a.revenue("bridge-fee-recovery", "USDC", spoke) : undefined;
      const dustAccount = dust > 0n ? await a.clearing("payout-dust", "USDC", spoke) : undefined;
      // On the hub the peg legs would be the same account twice, so they are left out.
      const crossVenue = spoke !== d.venue;
      const pegHub = crossVenue ? await a.clearing("usd-peg", d.asset, d.venue) : undefined;
      const pegSpoke = crossVenue ? await a.clearing("usd-peg", "USDC", spoke) : undefined;
      return {
        output: {
          partner: partner.id,
          orderId: done.id,
          fundingRef: link!.fundingRef!,
          usdcPaid: paid.toString(),
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
              ...(pegHub && pegSpoke
                ? [
                    { account: pegHub, direction: "C" as const, money: amountOf(d) },
                    { account: pegSpoke, direction: "D" as const, money: money("USDC", total) },
                  ]
                : []),
              { account: egress, direction: "C", money: money("USDC", paid) },
              ...(recovery ? [{ account: recovery, direction: "C" as const, money: money("USDC", bridgeFees) }] : []),
              ...(dustAccount ? [{ account: dustAccount, direction: "C" as const, money: money("USDC", dust) }] : []),
            ],
          },
        ],
      };
    },
  };
}

/**
 * Collection spoke: open an onramp order so the payer can pay local currency
 * in, then wait for the anchor to deliver USDC to Corridor's ingress wallet.
 */
export function partnerCollectLeg(opts: PartnerLegOptions): Leg<CollectionData> {
  return {
    kind: "partner.collect",
    maxAttempts: 3,
    async forward(ctx) {
      const d = ctx.data;
      const spoke = ctx.step.to.venue;
      const chain = CHAIN[spoke];
      if (!chain) throw new NonRetryableError(`partner.collect must deliver to a chain venue, got ${spoke}`);
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
      const ingress = await a.vault(`${spoke}-ingress`, "USDC", spoke);
      const pegSpoke = await a.clearing("usd-peg", "USDC", spoke);
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
              { account: pegSpoke, direction: "C", money: money("USDC", done.usdcAmount) },
            ],
          },
        ],
      };
    },
  };
}

/** Last step of a collection: credit the customer's USDC balance on the Stellar hub. */
export const ledgerCreditLeg: Leg<CollectionData> = {
  kind: "ledger.credit",
  maxAttempts: 1,
  async forward(ctx) {
    const d = ctx.data;
    const amount = flowAmount(ctx);
    const pegHub = await ctx.accounts.clearing("usd-peg", "USDC", "stellar");
    const customer = await ctx.accounts.customer(d.customerId, d.corridor, "USDC", "stellar");
    return {
      output: { credited: amount.toString() },
      bookings: [
        {
          kind: "collection.credit",
          reference: d.reference,
          sagaId: ctx.sagaId,
          lines: [
            { account: pegHub, direction: "D", money: money("USDC", amount) },
            { account: customer, direction: "C", money: money("USDC", amount) },
          ],
        },
      ],
    };
  },
};

/** Exact conversion between a 6 dp spoke (Solana, Base) and the hub's 7 dp. */
export const toHubPrecision = (amount: bigint) => rescale(amount, 6, 7);
export const toSpokePrecision = (amount: bigint) => rescale(amount, 7, 6);
