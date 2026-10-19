import { randomUUID } from "node:crypto";
import { FIAT, RefKind, customerTag, encodeRef, isFiat, uuidv7, type Asset, type Fiat } from "@corridor/core";
import { fundingMemoFor } from "@corridor/chain-stellar";
import { Accounts, Ledger, type Db } from "@corridor/ledger";
import { signWebhook, type Beneficiary, type PartnerOrder, type PartnerRegistry, type RampPartner } from "@corridor/partners";
import type { RampChain } from "./chain.ts";
import { RampError } from "./errors.ts";
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
  /** Outbound webhook transport. */
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface Caller {
  tenant: Tenant;
  key: ApiKey;
}

const PARTNER_TO_ORDER: Record<PartnerOrder["status"], OrderStatus | undefined> = {
  open: undefined,
  processing: "processing",
  completed: "completed",
  failed: "failed",
};

const FINAL: OrderStatus[] = ["completed", "failed"];
const MAX_DELIVERY_ATTEMPTS = 10;

export class RampService {
  readonly asset: Asset;
  readonly feeAccount: string;
  private readonly now: () => Date;
  private readonly ttl: number;

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
    return new RampService(await RampStore.open(opts.db), ledger, new Accounts(ledger), opts);
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
      const partner = this.opts.partners.get(q.partner);
      const po = await partnerCall(() =>
        partner.openPayout({
          currency: q.currency,
          chain: "STELLAR",
          usdcAmount: q.amount,
          beneficiary: { bankCode: args.beneficiary.bankCode, accountNumber: args.beneficiary.accountNumber },
          reference,
          webhookUrl: this.opts.partnerWebhookUrl?.(partner.id),
        }),
      );
      if (!po.fundingAddress) throw new RampError("partner_error", `${partner.id} returned no funding account`);
      const payments = [{ to: po.fundingAddress, asset: q.asset, amount: q.amount }];
      if (q.fee > 0n) payments.push({ to: this.feeAccount, asset: q.asset, amount: q.fee });
      const built = await this.opts.chain.buildFunding({
        source: args.account,
        payments,
        memo: fundingMemoFor(po, reference),
        timeoutSeconds: this.ttl,
      });
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
        fiatAmount: po.fiatAmount > 0n ? po.fiatAmount : q.fiatAmount,
        fee: q.fee,
        total: q.total,
        rate: q.rate,
        account: args.account,
        beneficiary: { ...args.beneficiary, ...(po.virtualAccount?.accountName ? { accountName: po.virtualAccount.accountName } : {}) },
        partner: partner.id,
        partnerOrderId: po.id,
        partnerStatus: po.partnerStatus,
        reference,
        unsignedXdr: built.xdr,
        xdrHash: built.hash,
        metadata: args.metadata,
        createdAt: now,
        updatedAt: now,
      };
      await this.store.insertOrder(order);
      await this.emit(caller.tenant, "order.created", orderView(order));
      return order;
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
    if (order.fee > 0n) {
      // Booked from the chain: the fee payment is operation 1 of the funding transaction.
      await this.ledger.post({
        kind: "ramp.fee",
        reference: order.reference,
        external: { venue: "stellar", ref: `${sent.hash}:1` },
        lines: [
          { account: await this.feeVault(), direction: "D", money: { asset: order.asset, amount: order.fee } },
          { account: await this.revenue(order.tenantId), direction: "C", money: { asset: order.asset, amount: order.fee } },
        ],
        metadata: { order: order.id, tenant: order.tenantId },
      });
    }
    await this.emit(caller.tenant, "order.updated", orderView(order));
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
      const partner = this.opts.partners.get(q.partner);
      const po = await partnerCall(() =>
        partner.openCollection({
          currency: q.currency,
          chain: "STELLAR",
          fiatAmount: q.fiatAmount,
          recipient: args.account,
          reference,
          webhookUrl: this.opts.partnerWebhookUrl?.(partner.id),
        }),
      );
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
        partner: partner.id,
        partnerOrderId: po.id,
        partnerStatus: po.partnerStatus,
        reference,
        virtualAccount: po.virtualAccount,
        metadata: args.metadata,
        createdAt: now,
        updatedAt: now,
      };
      await this.store.insertOrder(order);
      await this.emit(caller.tenant, "order.created", orderView(order));
      return order;
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

  // ── Internals ─────────────────────────────────────────────────────────

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
    const po = await partnerCall(() => this.opts.partners.get(order.partner).getOrder(order.partnerOrderId));
    return this.apply(tenant, order, po);
  }

  private async apply(tenant: Tenant, order: RampOrder, po: PartnerOrder): Promise<RampOrder> {
    if (FINAL.includes(order.status)) return order;
    let next = PARTNER_TO_ORDER[po.status];
    // A withdrawal is not "processing" for the user until their funding is on chain.
    if (order.kind === "withdrawal" && order.status === "awaiting_signature" && next !== "failed") next = undefined;
    if (!next || (next === order.status && po.partnerStatus === order.partnerStatus)) return order;
    order.status = next;
    order.partnerStatus = po.partnerStatus;
    order.updatedAt = this.now();
    if (order.kind === "deposit" && po.txSignature) order.txHash = po.txSignature;
    await this.store.updateOrder(order);
    if (order.kind === "deposit" && next === "completed" && order.fee > 0n) {
      // The anchor delivers straight to the user, so a deposit's fee is accrued
      // against the app and invoiced with the platform fee.
      await this.ledger.post({
        kind: "ramp.fee.accrued",
        reference: order.reference,
        external: { venue: "internal", ref: `ramp:deposit-fee:${order.id}` },
        lines: [
          { account: await this.receivable(order.tenantId), direction: "D", money: { asset: order.asset, amount: order.fee } },
          { account: await this.revenue(order.tenantId), direction: "C", money: { asset: order.asset, amount: order.fee } },
        ],
        metadata: { order: order.id, tenant: order.tenantId },
      });
    }
    await this.emit(tenant, "order.updated", orderView(order));
    return order;
  }

  private feeVault() {
    return this.accounts.vault("ramp:fees", this.asset, "stellar");
  }

  private revenue(tenantId: string) {
    return this.accounts.open({ type: "revenue", ownerType: "ramp_app", ownerId: tenantId, asset: this.asset, venue: "stellar" });
  }

  private receivable(tenantId: string) {
    return this.accounts.open({ type: "asset", ownerType: "ramp_app_receivable", ownerId: tenantId, asset: this.asset, venue: "stellar" });
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
  const { tenantId: _t, keyId: _k, xdrHash, unsignedXdr, ...rest } = o;
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

async function partnerCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RampError) throw e;
    throw new RampError("partner_error", (e as Error).message);
  }
}

