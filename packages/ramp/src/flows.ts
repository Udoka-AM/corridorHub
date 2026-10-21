import type { Asset, Fiat, Observation } from "@corridor/core";
import { fundingMemoFor, type StellarMemo } from "@corridor/chain-stellar";
import type { Accounts, EntryInput } from "@corridor/ledger";
import type { PartnerOrder, PartnerRegistry, RampPartner } from "@corridor/partners";
import { planRoute, type Edge, type Environment, type RoutePlan } from "@corridor/routing";
import { ManualReviewError, NonRetryableError, WaitingError, type Leg } from "@corridor/saga";
import type { RampChain } from "./chain.ts";
import { RampError } from "./errors.ts";
import type { OnChain, OrderKind, RampOrder } from "./store.ts";

/**
 * Ramp's orders run on the Hub's engines (ADR 0013): the route planner picks
 * the legs and the saga engine drives them, with the same exactly-once and
 * compensation rules. What Ramp adds is custody in the user's own wallet, so
 * a leg waits (`WaitingError`) for the user's signature and for the chain,
 * instead of moving money it holds.
 */

export interface FlowData {
  orderId: string;
  tenantId: string;
}

export interface FlowHost {
  partners: PartnerRegistry;
  chain: RampChain;
  feeAccount: string;
  ttlSeconds: number;
  now(): Date;
  partnerWebhookUrl?: (partnerId: string) => string;
  load(tenantId: string, id: string): Promise<RampOrder>;
  save(order: RampOrder): Promise<void>;
  /** The anchor order exists and the app may act on it. */
  opened(order: RampOrder): Promise<void>;
}

/** Placeholder until the anchor assigns its own id. */
export const PENDING_PARTNER_ORDER = "pending_";

/** Ramp's route graph: every anchor that settles on Stellar, against the asset Ramp settles in. */
export function rampEdges(asset: Asset, partners: PartnerRegistry): Edge[] {
  const stellar = { venue: "stellar" as const, asset };
  const edges: Edge[] = [];
  for (const p of partners.all()) {
    if (!p.chains.includes("STELLAR")) continue;
    for (const c of p.payoutCurrencies) edges.push({ kind: "partner.payout", from: stellar, to: { venue: "partner_fiat", asset: c }, cost: 1 });
    for (const c of p.collectionCurrencies) edges.push({ kind: "partner.collect", from: { venue: "partner_fiat", asset: c }, to: stellar, cost: 1 });
  }
  return edges;
}

export function rampPlan(kind: OrderKind, currency: Fiat, asset: Asset, env: Environment, edges: Edge[]): RoutePlan {
  const stellar = { venue: "stellar" as const, asset };
  const fiat = { venue: "partner_fiat" as const, asset: currency };
  return planRoute(
    kind === "withdrawal"
      ? { corridor: `USD-${currency}`, purpose: "payout", privacy: "public", source: stellar, destination: fiat, env, custody: "wallet" }
      : { corridor: `${currency}-USD`, purpose: "collection", privacy: "public", source: fiat, destination: stellar, env, custody: "wallet" },
    edges,
  );
}

export function rampAccounts(accounts: Accounts) {
  return {
    feeVault: (asset: Asset) => accounts.vault("ramp:fees", asset, "stellar"),
    revenue: (tenantId: string, asset: Asset) => accounts.open({ type: "revenue", ownerType: "ramp_app", ownerId: tenantId, asset, venue: "stellar" }),
    receivable: (tenantId: string, asset: Asset) =>
      accounts.open({ type: "asset", ownerType: "ramp_app_receivable", ownerId: tenantId, asset, venue: "stellar" }),
  };
}

/**
 * Withdrawal: open the anchor order and build the user's funding transaction,
 * wait for that transaction on chain, then for the anchor to pay out. The fee
 * is booked against the fee payment the chain showed, never the submit call.
 */
export function rampPayoutLeg(host: FlowHost): Leg<FlowData> {
  return {
    kind: "partner.payout",
    maxAttempts: 3,
    backoffMs: 100,
    async forward(ctx) {
      const order = await host.load(ctx.data.tenantId, ctx.data.orderId);
      if (!order.unsignedXdr) await opening(host, order, () => openPayout(host, order));
      if (!order.chain) {
        if (order.partnerState === "failed") throw new NonRetryableError(`${order.partner} failed the order before it was funded`);
        if (!order.txHash && order.fundingDeadline && host.now().getTime() > order.fundingDeadline.getTime()) {
          throw new NonRetryableError("the funding transaction lapsed unsigned");
        }
        throw new WaitingError("waiting for the funding transaction on chain");
      }
      if (order.partnerState === "failed") {
        // The anchor holds the user's funds: a refund is the anchor's to make, so a person follows it up.
        throw new ManualReviewError(`${order.partner} failed funded order ${order.partnerOrderId} (${order.partnerStatus})`);
      }
      if (order.partnerState !== "completed") throw new WaitingError("waiting for the anchor to pay out");
      const bookings: EntryInput[] = [];
      if (order.fee > 0n && order.chain.feeRef) {
        const acc = rampAccounts(ctx.accounts);
        bookings.push({
          kind: "ramp.fee",
          reference: order.reference,
          external: { venue: "stellar", ref: order.chain.feeRef },
          lines: [
            { account: await acc.feeVault(order.asset), direction: "D", money: { asset: order.asset, amount: order.fee } },
            { account: await acc.revenue(order.tenantId, order.asset), direction: "C", money: { asset: order.asset, amount: order.fee } },
          ],
          metadata: { order: order.id, tenant: order.tenantId },
        });
      }
      return { output: { partnerOrderId: order.partnerOrderId, fundingTx: order.chain.txHash }, bookings };
    },
  };
}

/**
 * Deposit: open the anchor collection, wait for the payer and the anchor, and
 * settle only once the delivery to the user's account is on chain.
 */
export function rampCollectLeg(host: FlowHost): Leg<FlowData> {
  return {
    kind: "partner.collect",
    maxAttempts: 3,
    backoffMs: 100,
    async forward(ctx) {
      const order = await host.load(ctx.data.tenantId, ctx.data.orderId);
      if (order.partnerOrderId.startsWith(PENDING_PARTNER_ORDER)) await opening(host, order, () => openCollection(host, order));
      if (order.partnerState === "failed") throw new NonRetryableError(`${order.partner} failed the collection`);
      if (order.partnerState !== "completed") throw new WaitingError("waiting for the payer and the anchor");
      if (!order.chain) throw new WaitingError("the anchor reports delivery; waiting to see it on chain");
      const bookings: EntryInput[] = [];
      if (order.fee > 0n) {
        // The anchor delivers straight to the user, so a deposit's fee is
        // accrued against the app and invoiced with the platform fee.
        const acc = rampAccounts(ctx.accounts);
        bookings.push({
          kind: "ramp.fee.accrued",
          reference: order.reference,
          external: { venue: "internal", ref: `ramp:deposit-fee:${order.id}` },
          lines: [
            { account: await acc.receivable(order.tenantId, order.asset), direction: "D", money: { asset: order.asset, amount: order.fee } },
            { account: await acc.revenue(order.tenantId, order.asset), direction: "C", money: { asset: order.asset, amount: order.fee } },
          ],
          metadata: { order: order.id, tenant: order.tenantId, deliveryTx: order.chain.txHash },
        });
      }
      return { output: { partnerOrderId: order.partnerOrderId, deliveryTx: order.chain.txHash }, bookings };
    },
  };
}

/** Run an opening step; a refusal the retry cannot change stops the saga, and is kept on the order. */
async function opening(host: FlowHost, order: RampOrder, open: () => Promise<void>) {
  try {
    await open();
  } catch (e) {
    const err = e instanceof RampError ? e : new RampError("partner_error", (e as Error).message);
    order.error = { code: err.code, message: err.message };
    await host.save(order);
    if (err.code === "partner_error") throw err;
    throw new NonRetryableError(err.message);
  }
}

async function openPayout(host: FlowHost, order: RampOrder) {
  const partner = host.partners.get(order.partner);
  let po: PartnerOrder;
  if (order.partnerOrderId.startsWith(PENDING_PARTNER_ORDER)) {
    po = await partnerCall(() =>
      partner.openPayout({
        currency: order.currency,
        chain: "STELLAR",
        usdcAmount: order.amount,
        beneficiary: { bankCode: order.beneficiary!.bankCode, accountNumber: order.beneficiary!.accountNumber },
        reference: order.reference,
        webhookUrl: host.partnerWebhookUrl?.(partner.id),
      }),
    );
    // Kept before anything else can fail, so a retry reuses this order rather than opening another.
    track(order, po);
    await host.save(order);
  } else {
    po = await partnerCall(() => partner.getOrder(order.partnerOrderId));
  }
  if (!po.fundingAddress) throw new RampError("partner_error", `${partner.id} returned no funding account`);
  const memo: StellarMemo = fundingMemoFor(po, order.reference);
  const payments = [{ to: po.fundingAddress, asset: order.asset, amount: order.amount }];
  if (order.fee > 0n) payments.push({ to: host.feeAccount, asset: order.asset, amount: order.fee });
  const built = await host.chain.buildFunding({ source: order.account, payments, memo, timeoutSeconds: host.ttlSeconds });
  order.fundingAddress = po.fundingAddress;
  order.fundingMemo = memo;
  order.fundingDeadline = new Date(host.now().getTime() + host.ttlSeconds * 1000);
  order.unsignedXdr = built.xdr;
  order.xdrHash = built.hash;
  if (po.fiatAmount > 0n) order.fiatAmount = po.fiatAmount;
  if (po.virtualAccount?.accountName) order.beneficiary = { ...order.beneficiary!, accountName: po.virtualAccount.accountName };
  delete order.error;
  order.updatedAt = host.now();
  await host.save(order);
  await host.opened(order);
}

async function openCollection(host: FlowHost, order: RampOrder) {
  const partner: RampPartner = host.partners.get(order.partner);
  const po = await partnerCall(() =>
    partner.openCollection({
      currency: order.currency,
      chain: "STELLAR",
      fiatAmount: order.fiatAmount,
      recipient: order.account,
      reference: order.reference,
      webhookUrl: host.partnerWebhookUrl?.(partner.id),
    }),
  );
  track(order, po);
  order.virtualAccount = po.virtualAccount;
  delete order.error;
  order.updatedAt = host.now();
  await host.save(order);
  await host.opened(order);
}

function track(order: RampOrder, po: PartnerOrder) {
  order.partnerOrderId = po.id;
  order.partnerStatus = po.partnerStatus;
  order.partnerState = po.status;
}

export async function partnerCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RampError) throw e;
    throw new RampError("partner_error", (e as Error).message);
  }
}

const txOf = (o: Observation) => o.externalRef.split(":")[0]!;

/**
 * What on chain settles an order, if anything yet. A withdrawal matches the
 * user's payment to the anchor's account carrying the anchor's memo, for the
 * exact amount; a deposit matches a delivery into the user's account in the
 * transaction the anchor reported (or carrying the order's reference).
 */
export function matchOnChain(order: RampOrder, seen: Observation[], feeAccount: string): OnChain | undefined {
  if (order.kind === "withdrawal") {
    if (!order.fundingAddress || !order.fundingMemo) return undefined;
    const memo = order.fundingMemo;
    const pay = seen.find(
      (o) =>
        o.from === order.account &&
        o.to === order.fundingAddress &&
        o.asset === order.asset &&
        o.amount === order.amount &&
        (memo.type === "hash" ? o.reference === memo.value : o.memo?.type === memo.type && o.memo.value === memo.value),
    );
    if (!pay) return undefined;
    const fee =
      order.fee > 0n
        ? seen.find((o) => txOf(o) === txOf(pay) && o.to === feeAccount && o.asset === order.asset && o.amount === order.fee)
        : undefined;
    if (order.fee > 0n && !fee) return undefined;
    return onChain(pay, fee);
  }
  const hit = seen.find(
    (o) =>
      o.to === order.account &&
      o.from !== order.account &&
      o.asset === order.asset &&
      o.amount > 0n &&
      ((order.deliveryTx !== undefined && txOf(o) === order.deliveryTx) || o.reference === order.reference),
  );
  return hit ? onChain(hit) : undefined;
}

function onChain(pay: Observation, fee?: Observation): OnChain {
  return {
    txHash: txOf(pay),
    ...(pay.blockNumber !== undefined ? { ledger: pay.blockNumber.toString() } : {}),
    paymentRef: pay.externalRef,
    ...(fee ? { feeRef: fee.externalRef } : {}),
    amount: pay.amount.toString(),
    observedAt: pay.observedAt.toISOString(),
  };
}
