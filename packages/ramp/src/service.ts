import { randomUUID } from "node:crypto";
import { FIAT, RefKind, customerTag, encodeRef, isFiat, uuidv7, type Asset, type Fiat } from "@corridor/core";
import { StellarObserver, type PaymentSource } from "@corridor/chain-stellar";
import { Accounts, Ledger, type Db } from "@corridor/ledger";
import { signWebhook, type Beneficiary, type PartnerOrder, type PartnerRegistry, type RampPartner } from "@corridor/partners";
import { SagaEngine, type SagaStatus } from "@corridor/saga";
import type { RampChain } from "./chain.ts";
import { RampError } from "./errors.ts";
import { PENDING_PARTNER_ORDER, matchOnChain, partnerCall, rampAccounts, rampCollectLeg, rampEdges, rampPayoutLeg, rampPlan, type FlowHost } from "./flows.ts";
import { PLANS, formatRate, planOf, rampFee, scaleRate, toFiat, toSettlement, type PlanId } from "./fees.ts";
import { checkSpend, hashKey, newApiKey, newSecret, type SpendingPolicy } from "./keys.ts";
import { RampStore, toJson, type ApiKey, type OrderKind, type OrderStatus, type Quote, type RampEvent, type RampOrder, type Tenant } from "./store.ts";

/**
 * Ramp: the hosted front door onto the hub's core (plan §Architecture).
 *
 * Every request runs on the same pieces the self-hosted Hub uses: anchors
 * behind the `RampPartner` interface, the 32-byte Corridor Reference, and
 * the double-entry ledger. What differs is the surface (API keys, tenants,
 * quotes, webhooks) and the keys: Ramp builds transactions and the end
 * user's own wallet signs them.
 */
export interface RampServiceOptions {
  db: Db;
  partners: PartnerRegistry;
  chain: RampChain;
  /** The Stellar asset users hold and settle in. USDC by default. */
  asset?: Asset;
  /** Where Ramp's on-chain fees are paid. Defaults to the sponsor account. */
  feeAccount?: string;
  /** Public base URL, for collection links. */
  publicUrl: string;
  /** Where anchors send status webhooks, given the partner id. */
  partnerWebhookUrl?: (partnerId: string) => string;
  quoteTtlSeconds?: number;
  /** Horizon payments, for settling orders from the chain (ADR 0008). Without it no order settles. */
  payments?: PaymentSource;
  /** Outbound webhook transport. */
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface Caller {
  tenant: Tenant;
  key: ApiKey;
}

const FINAL: OrderStatus[] = ["completed", "failed"];
const MAX_DELIVERY_ATTEMPTS = 10;

export class RampService {
  readonly asset: Asset;
  readonly feeAccount: string;
  private readonly now: () => Date;
  private readonly ttl: number;
  private saga!: SagaEngine;

  private constructor(
    readonly store: RampStore,
    readonly ledger: Ledger,
    private readonly accounts: Accounts,
    private readonly opts: RampServiceOptions,
  ) {
    this.asset = opts.asset ?? "USDC";
    this.feeAccount = opts.feeAccount ?? opts.chain.sponsor;
    this.now = opts.now ?? (() => new Date());
    this.ttl = opts.quoteTtlSeconds ?? 120;
  }

  static async open(opts: RampServiceOptions): Promise<RampService> {
    const ledger = await Ledger.open(opts.db);
    const accounts = new Accounts(ledger);
    const service = new RampService(await RampStore.open(opts.db), ledger, accounts, opts);
    const host = service.flowHost();
    service.saga = await SagaEngine.open(opts.db, ledger, accounts, [rampPayoutLeg(host), rampCollectLeg(host)]);
    return service;
  }

  get network() {
    return this.opts.chain.network;
  }

  // ── Tenants and keys ──────────────────────────────────────────────────

  async createTenant(args: { name: string; plan?: PlanId; webhookUrl?: string }) {
    const plan = planOf(args.plan ?? "sandbox");
    if (plan.testnetOnly && this.network !== "testnet") throw new RampError("forbidden", `the ${plan.id} plan runs on testnet only`);
    if (!args.name?.trim()) throw new RampError("invalid_request", "name is required");
    const tenant: Tenant = {
      id: `app_${uuidv7().replaceAll("-", "")}`,
      name: args.name.trim(),
      plan: plan.id,
      network: this.network,
      webhookUrl: args.webhookUrl,
      webhookSecret: newSecret("whsec"),
      refSecret: newSecret("ref"),
      createdAt: this.now(),
    };
    await this.store.createTenant(tenant);
    const secretKey = newApiKey("secret", this.network);
    await this.store.addKey({ id: `key_${randomUUID()}`, tenantId: tenant.id, kind: "secret", label: "default", hash: hashKey(secretKey) });
    return { tenant: tenantView(tenant), secretKey, webhookSecret: tenant.webhookSecret };
  }

  async authenticate(apiKey: string | undefined): Promise<Caller> {
    if (!apiKey) throw new RampError("unauthorized", "missing API key");
    const key = await this.store.keyByHash(hashKey(apiKey));
    if (!key) throw new RampError("unauthorized", "unknown or revoked API key");
    const tenant = await this.store.tenant(key.tenantId);
    if (!tenant) throw new RampError("unauthorized", "unknown app");
    return { tenant, key };
  }

  async createKey(caller: Caller, args: { kind?: "secret" | "agent"; label?: string; policy?: SpendingPolicy }) {
    requireSecret(caller);
    const kind = args.kind ?? "agent";
    if (kind === "secret" && args.policy) throw new RampError("invalid_request", "spending policies apply to agent keys");
    const key = newApiKey(kind, this.network);
    const id = `key_${randomUUID()}`;
    await this.store.addKey({ id, tenantId: caller.tenant.id, kind, label: args.label, policy: args.policy, hash: hashKey(key) });
    return { id, kind, label: args.label, key };
  }

  async listKeys(caller: Caller) {
    requireSecret(caller);
    return this.store.listKeys(caller.tenant.id);
  }

  async revokeKey(caller: Caller, id: string) {
    requireSecret(caller);
    if (id === caller.key.id) throw new RampError("conflict", "a key cannot revoke itself");
    if (!(await this.store.revokeKey(caller.tenant.id, id))) throw new RampError("not_found", `no key ${id}`);
  }

  async setWebhook(caller: Caller, url: string | null) {
    requireSecret(caller);
    if (url !== null) assertUrl(url);
    await this.store.updateWebhook(caller.tenant.id, url);
    return { url, secret: caller.tenant.webhookSecret };
  }

  // ── Quotes ────────────────────────────────────────────────────────────

  /**
   * A firm price for a withdrawal (stablecoin → local currency) or deposit
   * (local currency → stablecoin). `amount` is in settlement minor units for
   * a withdrawal and fiat minor units for a deposit.
   */
  async quote(caller: Caller, args: { kind: OrderKind; currency: string; amount: bigint }): Promise<Quote> {
    if (args.kind !== "withdrawal" && args.kind !== "deposit") throw new RampError("invalid_request", "kind is withdrawal or deposit");
    const currency = fiat(args.currency);
    if (args.amount <= 0n) throw new RampError("invalid_request", "amount must be positive");
    const partner = this.partnerFor(args.kind, currency);
    const rates = await partnerCall(() => partner.rates(currency));
    const plan = PLANS[caller.tenant.plan];
    let amount: bigint, fiatAmount: bigint, fee: bigint, total: bigint, rate: bigint;
    if (args.kind === "withdrawal") {
      rate = scaleRate(rates.offRamp);
      amount = args.amount;
      fiatAmount = toFiat(amount, rate, currency);
      fee = rampFee(plan, amount, "withdrawal");
      total = amount + fee;
    } else {
      rate = scaleRate(rates.onRamp);
      fiatAmount = args.amount;
      amount = toSettlement(fiatAmount, rate, currency);
      fee = rampFee(plan, amount, "deposit");
      if (fee >= amount) throw new RampError("invalid_request", "deposit is too small to cover fees");
      total = amount - fee;
    }
    if (fiatAmount <= 0n || amount <= 0n) throw new RampError("invalid_request", "amount is too small to quote");
    const created = this.now();
    const q: Quote = {
      id: `qt_${uuidv7().replaceAll("-", "")}`,
      tenantId: caller.tenant.id,
      kind: args.kind,
      currency,
      asset: this.asset,
      partner: partner.id,
      amount,
      fiatAmount,
      fee,
      total,
      rate: formatRate(rate),
      expiresAt: new Date(created.getTime() + this.ttl * 1000),
      createdAt: created,
    };
    await this.store.saveQuote(q);
    return q;
  }

  // ── Embedded accounts ─────────────────────────────────────────────────

  /**
   * Onboard an end user's wallet: Ramp sponsors the account's reserves and
   * enables the settlement asset, so the user holds USDC from the first
   * minute without owning XLM. Returns a transaction the sponsor has signed
   * and the user's wallet must co-sign.
   */
  async createAccount(caller: Caller, args: { address: string }) {
    assertAddress(args.address);
    const built = await this.opts.chain.buildSponsoredAccount({ account: args.address, assets: [this.asset], timeoutSeconds: this.ttl });
    await this.store.upsertAccount(caller.tenant.id, args.address, "pending");
    return { address: args.address, status: "pending" as const, asset: this.asset, xdr: built.xdr, hash: built.hash };
  }

  async submitAccount(caller: Caller, args: { address: string; signedXdr: string; hash: string }) {
    const known = await this.store.account(caller.tenant.id, args.address);
    if (!known) throw new RampError("not_found", `no account onboarding for ${args.address}`);
    const sent = await this.opts.chain.submit(args.signedXdr, args.hash);
    await this.store.upsertAccount(caller.tenant.id, args.address, "active", sent.hash);
    await this.emit(caller.tenant, "account.active", { address: args.address, txHash: sent.hash });
    return { address: args.address, status: "active" as const, txHash: sent.hash };
  }

  async getAccount(caller: Caller, address: string) {
    const a = await this.store.account(caller.tenant.id, address);
    if (!a) throw new RampError("not_found", `no account ${address}`);
    return a;
  }

  // ── Withdrawals (payouts) ─────────────────────────────────────────────

  /**
   * Pay local currency to a bank account or mobile wallet from the user's
   * Stellar account. Opens the order with the anchor, then returns one
   * transaction that funds it (carrying the anchor's memo) and pays Ramp's
   * fee. The user signs; Ramp submits with the fee sponsored.
   */
  async createWithdrawal(
    caller: Caller,
    args: { quoteId: string; account: string; beneficiary: Beneficiary; metadata?: Record<string, string> },
  ): Promise<RampOrder> {
    assertAddress(args.account);
    if (!args.beneficiary?.bankCode || !args.beneficiary?.accountNumber) {
      throw new RampError("invalid_request", "beneficiary needs bankCode and accountNumber");
    }
    const q = await this.spendQuote(caller, args.quoteId, "withdrawal");
    try {
      if (caller.key.kind === "agent") {
        const since = startOfDay(this.now());
        checkSpend(caller.key.policy, { amount: q.amount, currency: q.currency, spentToday: await this.store.spentByKey(caller.key.id, since) });
      }
      const id = uuidv7();
      const reference = this.referenceFor(caller.tenant, RefKind.Payout, q.currency, id);
      const now = this.now();
      const order: RampOrder = {
        id: `wd_${id.replaceAll("-", "")}`,
        tenantId: caller.tenant.id,
        keyId: caller.key.id,
        kind: "withdrawal",
        status: "awaiting_signature",
        currency: q.currency,
        asset: q.asset,
        amount: q.amount,
        fiatAmount: q.fiatAmount,
        fee: q.fee,
        total: q.total,
        rate: q.rate,
        account: args.account,
        beneficiary: { ...args.beneficiary },
        partner: q.partner,
        partnerOrderId: `${PENDING_PARTNER_ORDER}${id}`,
        partnerStatus: "",
        reference,
        metadata: args.metadata,
        createdAt: now,
        updatedAt: now,
      };
      return await this.startFlow(caller, order, q);
    } catch (e) {
      await this.store.releaseQuote(caller.tenant.id, q.id);
      throw e;
    }
  }

  async submitWithdrawal(caller: Caller, id: string, signedXdr: string): Promise<RampOrder> {
    const order = await this.mustOrder(caller, id, "withdrawal");
    if (order.status !== "awaiting_signature") throw new RampError("conflict", `withdrawal is ${order.status}`);
    const sent = await this.opts.chain.submit(signedXdr, order.xdrHash!);
    order.txHash = sent.hash;
    order.status = "submitted";
    order.updatedAt = this.now();
    await this.store.updateOrder(order);
    await this.emit(caller.tenant, "order.updated", orderView(order));
    // Nothing is booked here: the fee and the order settle when the chain shows the transaction (`reconcile`).
    return this.refresh(caller.tenant, order);
  }

  // ── Deposits (collections) ────────────────────────────────────────────

  /**
   * Collect local currency into a Stellar account: the anchor issues bank
   * details for the payer, and delivers the settlement asset to `account`
   * when the transfer lands. The response carries a hosted collection link.
   */
  async createDeposit(caller: Caller, args: { quoteId: string; account: string; metadata?: Record<string, string> }): Promise<RampOrder> {
    assertAddress(args.account);
    const q = await this.spendQuote(caller, args.quoteId, "deposit");
    try {
      const id = uuidv7();
      const reference = this.referenceFor(caller.tenant, RefKind.Collection, q.currency, id);
      const now = this.now();
      const order: RampOrder = {
        id: `dp_${id.replaceAll("-", "")}`,
        tenantId: caller.tenant.id,
        keyId: caller.key.id,
        kind: "deposit",
        status: "awaiting_payment",
        currency: q.currency,
        asset: q.asset,
        amount: q.amount,
        fiatAmount: q.fiatAmount,
        fee: q.fee,
        total: q.total,
        rate: q.rate,
        account: args.account,
        partner: q.partner,
        partnerOrderId: `${PENDING_PARTNER_ORDER}${id}`,
        partnerStatus: "",
        reference,
        metadata: args.metadata,
        createdAt: now,
        updatedAt: now,
      };
      return await this.startFlow(caller, order, q);
    } catch (e) {
      await this.store.releaseQuote(caller.tenant.id, q.id);
      throw e;
    }
  }

  collectionLink(order: RampOrder): string {
    return `${this.opts.publicUrl.replace(/\/$/, "")}/pay/${order.id}`;
  }

  /** The public view behind a collection link: what to pay, where. No tenant secrets. */
  async collectionPage(id: string) {
    const { rows } = await this.opts.db.query<{ tenant_id: string }>(`SELECT tenant_id FROM ramp_orders WHERE id = $1 AND kind = 'deposit'`, [id]);
    const tenantId = rows[0]?.tenant_id;
    const order = tenantId ? await this.store.order(tenantId, id) : undefined;
    const tenant = tenantId ? await this.store.tenant(tenantId) : undefined;
    if (!order || !tenant) throw new RampError("not_found", "no such collection");
    return { id: order.id, merchant: tenant.name, status: order.status, currency: order.currency, fiatAmount: order.fiatAmount, bank: order.virtualAccount };
  }

  // ── Status ────────────────────────────────────────────────────────────

  async getOrder(caller: Caller, id: string): Promise<RampOrder> {
    const order = await this.mustOrder(caller, id);
    return this.refresh(caller.tenant, order);
  }

  async listOrders(caller: Caller, opts: { kind?: OrderKind; limit?: number } = {}) {
    return this.store.orders(caller.tenant.id, opts);
  }

  /** An anchor's signed status webhook. Verified by the partner's own scheme. */
  async handlePartnerWebhook(partnerId: string, rawBody: string, headers: Record<string, string | undefined>) {
    let partner: RampPartner;
    try {
      partner = this.opts.partners.get(partnerId);
    } catch {
      throw new RampError("not_found", `no partner ${partnerId}`);
    }
    if (!partner.verifyWebhook(rawBody, headers)) throw new RampError("unauthorized", "bad webhook signature");
    const po = partner.parseWebhook(rawBody);
    const order = await this.store.orderByPartner(partnerId, po.id);
    if (!order) return { matched: false };
    const tenant = (await this.store.tenant(order.tenantId))!;
    await this.apply(tenant, order, po);
    return { matched: true, order: order.id };
  }

  // ── Usage ─────────────────────────────────────────────────────────────

  /** Per-app volume and fees for a period (the dashboard's numbers). */
  async usage(caller: Caller, args: { since?: Date; until?: Date } = {}) {
    const now = this.now();
    const since = args.since ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const orders = await this.store.orders(caller.tenant.id, { since, until: args.until, limit: 100_000 });
    const byKind = (kind: OrderKind) => {
      const os = orders.filter((o) => o.kind === kind);
      const done = os.filter((o) => o.status === "completed");
      const byCurrency: Record<string, { count: number; amount: bigint; fiatAmount: bigint }> = {};
      for (const o of done) {
        const c = (byCurrency[o.currency] ??= { count: 0, amount: 0n, fiatAmount: 0n });
        c.count++;
        c.amount += o.amount;
        c.fiatAmount += o.fiatAmount;
      }
      return {
        orders: os.length,
        completed: done.length,
        failed: os.filter((o) => o.status === "failed").length,
        volume: done.reduce((s, o) => s + o.amount, 0n),
        fees: done.reduce((s, o) => s + o.fee, 0n),
        byCurrency,
      };
    };
    const plan = PLANS[caller.tenant.plan];
    return {
      app: caller.tenant.id,
      plan: { id: plan.id, bps: plan.bps, perCall: plan.perCall, monthlyUsdCents: plan.monthlyUsdCents },
      period: { since, until: args.until ?? now },
      asset: this.asset,
      withdrawals: byKind("withdrawal"),
      deposits: byKind("deposit"),
      feesBookedAllTime: (await this.ledger.balance(await this.revenue(caller.tenant.id))).amount,
    };
  }

  // ── Events and webhooks to apps ───────────────────────────────────────

  async events(caller: Caller, opts: { after?: string; limit?: number } = {}) {
    return this.store.events(caller.tenant.id, opts);
  }

  /** Retry deliveries that have not yet succeeded. Run on a timer in the hosted service. */
  async deliverPending(): Promise<number> {
    let delivered = 0;
    for (const { tenantId, event, attempts } of await this.store.undelivered()) {
      if (attempts >= MAX_DELIVERY_ATTEMPTS) continue;
      const tenant = await this.store.tenant(tenantId);
      if (tenant && (await this.deliver(tenant, event))) delivered++;
    }
    return delivered;
  }

  // ── Settlement from the chain ─────────────────────────────────────────

  /**
   * Match open orders against what Horizon shows for their users' accounts,
   * by memo (ADR 0008), then move each order's saga on. An order settles only
   * here: an anchor's "completed" alone never completes it. Run on a timer.
   * Returns how many orders changed status.
   */
  async reconcile(): Promise<number> {
    const open = await this.store.openOrders();
    if (this.opts.payments) {
      const watched = [...new Set(open.filter((o) => !o.chain && o.partnerOrderId && !o.partnerOrderId.startsWith(PENDING_PARTNER_ORDER)).map((o) => o.account))];
      for (const account of watched) {
        // One observer per account, so each keeps its own cursor as the watched set changes.
        const observer = new StellarObserver(this.opts.payments, {
          name: `ramp:${account}`,
          network: this.opts.chain.network,
          accounts: [account],
          cursors: this.store.cursors,
          unreferenced: true,
        });
        await this.store.saveObservations(account, await observer.poll());
        const seen = await this.store.unmatchedObservations(account);
        for (const order of open.filter((o) => o.account === account && !o.chain)) {
          const hit = matchOnChain(order, seen, this.feeAccount);
          if (!hit || !(await this.store.matchObservations(order.id, [hit.paymentRef, ...(hit.feeRef ? [hit.feeRef] : [])]))) continue;
          order.chain = hit;
          order.updatedAt = this.now();
          await this.store.updateOrder(order);
        }
      }
    }
    let changed = 0;
    for (const order of open) {
      const tenant = await this.store.tenant(order.tenantId);
      if (!tenant) continue;
      const after = await this.advance(tenant, order);
      if (after.status !== order.status) changed++;
    }
    return changed;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private flowHost(): FlowHost {
    return {
      partners: this.opts.partners,
      chain: this.opts.chain,
      feeAccount: this.feeAccount,
      ttlSeconds: this.ttl,
      now: () => this.now(),
      partnerWebhookUrl: this.opts.partnerWebhookUrl,
      load: async (tenantId, id) => {
        const o = await this.store.order(tenantId, id);
        if (!o) throw new Error(`order ${id} vanished`);
        return o;
      },
      save: (o) => this.store.updateOrder(o),
      opened: async (o) => {
        const tenant = await this.store.tenant(o.tenantId);
        if (tenant) await this.emit(tenant, "order.created", orderView(o));
      },
    };
  }

  /** Plan the route, start the saga and drive it until it waits on the user, the anchor or the chain. */
  private async startFlow(caller: Caller, order: RampOrder, q: Quote): Promise<RampOrder> {
    const plan = rampPlan(order.kind, order.currency, order.asset, this.network, rampEdges(order.asset, this.opts.partners));
    await this.store.insertOrder(order);
    order.sagaId = await this.saga.start({ kind: `ramp.${order.kind}`, reference: order.reference, plan, data: { orderId: order.id, tenantId: order.tenantId } });
    await this.store.updateOrder(order);
    const after = await this.advance(caller.tenant, order);
    if (after.status === "failed" && after.error) {
      // The order never became actionable (no anchor order, or no transaction to sign): nothing is kept and the caller releases the quote.
      await this.store.deleteOrder(order.tenantId, order.id);
      const err = after.error ?? { code: "partner_error", message: "the anchor did not open the order" };
      throw new RampError(err.code as RampError["code"], err.message);
    }
    void q;
    return after;
  }

  /** Run the order's saga as far as it goes, then derive the order's status from it. */
  private async advance(tenant: Tenant, order: RampOrder): Promise<RampOrder> {
    if (FINAL.includes(order.status) || !order.sagaId) return order;
    const saga = await this.saga.run(order.sagaId);
    const fresh = (await this.store.order(order.tenantId, order.id)) ?? order;
    const next = statusOf(fresh, saga);
    if (next === fresh.status) return fresh;
    fresh.status = next;
    fresh.updatedAt = this.now();
    await this.store.updateOrder(fresh);
    if (!fresh.error) await this.emit(tenant, "order.updated", orderView(fresh));
    return fresh;
  }

  private partnerFor(kind: OrderKind, currency: Fiat): RampPartner {
    try {
      return kind === "withdrawal" ? this.opts.partners.forPayout(currency, "STELLAR") : this.opts.partners.forCollection(currency, "STELLAR");
    } catch {
      const supported = [
        ...new Set(this.opts.partners.all().flatMap((p) => (kind === "withdrawal" ? p.payoutCurrencies : p.collectionCurrencies).filter(() => p.chains.includes("STELLAR")))),
      ];
      throw new RampError("unsupported", `no anchor for ${kind === "withdrawal" ? "payouts" : "collections"} in ${currency}`, { supported });
    }
  }

  private async spendQuote(caller: Caller, quoteId: string, kind: OrderKind): Promise<Quote> {
    const q = await this.store.quote(caller.tenant.id, quoteId);
    if (!q || q.kind !== kind) throw new RampError("not_found", `no ${kind} quote ${quoteId}`);
    if (q.usedAt) throw new RampError("quote_used", "quote already used; request a new one");
    if (q.expiresAt.getTime() <= this.now().getTime()) throw new RampError("quote_expired", "quote expired; request a new one");
    if (!(await this.store.useQuote(caller.tenant.id, quoteId))) throw new RampError("quote_used", "quote already used; request a new one");
    return q;
  }

  private referenceFor(tenant: Tenant, kind: RefKind, currency: Fiat, id: string) {
    const [source, destination] = kind === RefKind.Payout ? (["USD", currency] as const) : ([currency, "USD"] as const);
    return encodeRef({ kind, corridor: `${source}-${destination}`, shielded: false, id, customerTag: customerTag(tenant.id, tenant.refSecret) });
  }

  private async mustOrder(caller: Caller, id: string, kind?: OrderKind): Promise<RampOrder> {
    const order = await this.store.order(caller.tenant.id, id);
    if (!order || (kind && order.kind !== kind)) throw new RampError("not_found", `no ${kind ?? "order"} ${id}`);
    return order;
  }

  private async refresh(tenant: Tenant, order: RampOrder): Promise<RampOrder> {
    if (FINAL.includes(order.status)) return order;
    if (order.partnerOrderId.startsWith(PENDING_PARTNER_ORDER)) return this.advance(tenant, order);
    const po = await partnerCall(() => this.opts.partners.get(order.partner).getOrder(order.partnerOrderId));
    return this.apply(tenant, order, po);
  }

  /** Record what the anchor says; the saga decides what it means for the order. */
  private async apply(tenant: Tenant, order: RampOrder, po: PartnerOrder): Promise<RampOrder> {
    if (FINAL.includes(order.status)) return order;
    const delivery = order.kind === "deposit" && po.txSignature ? po.txSignature : order.deliveryTx;
    if (po.status !== order.partnerState || po.partnerStatus !== order.partnerStatus || delivery !== order.deliveryTx) {
      order.partnerState = po.status;
      order.partnerStatus = po.partnerStatus;
      if (delivery) order.deliveryTx = delivery;
      order.updatedAt = this.now();
      await this.store.updateOrder(order);
    }
    return this.advance(tenant, order);
  }

  private revenue(tenantId: string) {
    return rampAccounts(this.accounts).revenue(tenantId, this.asset);
  }

  private async emit(tenant: Tenant, type: string, data: unknown) {
    const event: RampEvent = { id: `evt_${uuidv7().replaceAll("-", "")}`, type, createdAt: this.now(), data: toJson(data) };
    await this.store.addEvent(tenant.id, event);
    await this.deliver(tenant, event);
  }

  private async deliver(tenant: Tenant, event: RampEvent): Promise<boolean> {
    if (!tenant.webhookUrl) return false;
    const body = JSON.stringify(event);
    const ts = Math.floor(this.now().getTime() / 1000);
    try {
      const res = await (this.opts.fetch ?? fetch)(tenant.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ramp-timestamp": String(ts), "x-ramp-signature": signWebhook(tenant.webhookSecret, ts, body) },
        body,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this.store.markDelivery(event.id);
      return true;
    } catch (e) {
      await this.store.markDelivery(event.id, (e as Error).message);
      return false;
    }
  }
}

export function tenantView(t: Tenant) {
  return { id: t.id, name: t.name, plan: t.plan, network: t.network, webhookUrl: t.webhookUrl ?? null, createdAt: t.createdAt };
}

/** What the API returns for an order. */
export function orderView(o: RampOrder) {
  const { tenantId: _t, keyId: _k, sagaId: _s, error: _e, xdrHash, unsignedXdr, ...rest } = o;
  return {
    ...rest,
    ...(o.status === "awaiting_signature" && unsignedXdr ? { transaction: { xdr: unsignedXdr, hash: xdrHash } } : {}),
  };
}

export function quoteView(q: Quote) {
  const { tenantId: _t, ...rest } = q;
  return rest;
}

function requireSecret(caller: Caller) {
  if (caller.key.kind !== "secret") throw new RampError("forbidden", "this needs the app's secret key");
}

function fiat(code: string): Fiat {
  if (typeof code !== "string" || !isFiat(code as Fiat) || !(code in FIAT)) throw new RampError("invalid_request", `unknown currency ${code}`);
  return code as Fiat;
}

function assertAddress(a: string) {
  if (typeof a !== "string" || !/^G[A-Z2-7]{55}$/.test(a)) throw new RampError("invalid_request", "account must be a Stellar G… address");
}

function assertUrl(u: string) {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    throw new RampError("invalid_request", "webhook url must be http(s)");
  }
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function statusOf(order: RampOrder, saga: SagaStatus): OrderStatus {
  if (saga === "completed") return "completed";
  if (saga === "compensated" || saga === "manual_review") return "failed";
  if (order.kind === "withdrawal") return order.chain ? "processing" : order.txHash ? "submitted" : "awaiting_signature";
  return order.partnerState === "processing" || order.partnerState === "completed" ? "processing" : "awaiting_payment";
}
