import { randomBytes, randomUUID } from "node:crypto";
import { FIAT, type Fiat, assetDecimals } from "@corridor/core";
import {
  PartnerError,
  type CollectionRequest,
  type OrderStatus,
  type PartnerChain,
  type PartnerOrder,
  type PayoutRequest,
  type RampPartner,
  type Rates,
} from "./types.ts";
import { header, signWebhook, verifyWebhookSignature } from "./webhook.ts";

/** The hub's own precision, so the mock prices like a real anchor. */
const USDC_DP = assetDecimals("USDC");

/**
 * A ramp partner for testnet and tests, behaving like Paj: one-off funding
 * addresses for payouts, one-off virtual accounts for collections, the same
 * status machine (INIT → PROCESSING → COMPLETED | ERROR) and the same signed
 * webhooks. The chain side is injected, so on devnet the payout funding can
 * be a real Solana transfer and the collection delivery a real USDC send.
 */

export interface MockPartnerOptions {
  id?: string;
  webhookSecret: string;
  /** Receives every status change as a signed delivery (e.g. POST to the webhook server). */
  deliver?: (rawBody: string, headers: Record<string, string>) => Promise<void>;
  /** Collections: send USDC to the order's recipient once the payer's transfer "arrives". */
  sendUsdc?: (recipient: string, usdcAmount: bigint, chain: PartnerChain) => Promise<string>;
  rates?: Partial<Record<Fiat, { onRamp: number; offRamp: number }>>;
  /** Make payouts fail at PROCESSING (bank rejected), for failure-path tests. */
  failPayouts?: boolean;
}

const DEFAULT_RATES: Partial<Record<Fiat, { onRamp: number; offRamp: number }>> = {
  NGN: { onRamp: 1_560, offRamp: 1_530 },
  KES: { onRamp: 130.5, offRamp: 128.9 },
  GHS: { onRamp: 15.9, offRamp: 15.4 },
  CNY: { onRamp: 7.21, offRamp: 7.14 },
  HKD: { onRamp: 7.83, offRamp: 7.79 },
  USD: { onRamp: 1, offRamp: 1 },
};

const PARTNER_STATUS: Record<OrderStatus, string> = { open: "INIT", processing: "PROCESSING", completed: "COMPLETED", failed: "ERROR" };

export class MockPartner implements RampPartner {
  readonly id: string;
  readonly payoutCurrencies: readonly Fiat[];
  readonly collectionCurrencies: readonly Fiat[] = ["NGN", "KES", "GHS"];
  readonly chains: readonly PartnerChain[] = ["SOLANA"];
  private readonly orders = new Map<string, PartnerOrder>();

  constructor(private readonly opts: MockPartnerOptions) {
    this.id = opts.id ?? "mock";
    this.payoutCurrencies = Object.keys({ ...DEFAULT_RATES, ...opts.rates }) as Fiat[];
  }

  async rates(currency: Fiat): Promise<Rates> {
    const r = { ...DEFAULT_RATES, ...this.opts.rates }[currency];
    if (!r) throw new PartnerError(`no rate for ${currency}`, this.id);
    return { currency, ...r, at: new Date() };
  }

  async openPayout(req: PayoutRequest): Promise<PartnerOrder> {
    const { offRamp } = await this.rates(req.currency);
    const order: PartnerOrder = {
      partner: this.id,
      id: `mock_${randomUUID()}`,
      kind: "payout",
      status: "open",
      partnerStatus: "INIT",
      chain: req.chain,
      currency: req.currency,
      usdcAmount: req.usdcAmount,
      fiatAmount: toMinor(req.currency, (Number(req.usdcAmount) / 10 ** USDC_DP) * offRamp),
      rate: offRamp,
      fundingAddress: base58(randomBytes(32)), // a valid Solana address, so devnet funding can be a real transfer
      reference: req.reference,
      createdAt: new Date(),
    };
    this.orders.set(order.id, order);
    await this.emit(order);
    return { ...order };
  }

  async openCollection(req: CollectionRequest): Promise<PartnerOrder> {
    const { onRamp } = await this.rates(req.currency);
    const usdc = BigInt(Math.floor((Number(req.fiatAmount) / 10 ** FIAT[req.currency].decimals / onRamp) * 10 ** USDC_DP));
    const order: PartnerOrder = {
      partner: this.id,
      id: `mock_${randomUUID()}`,
      kind: "collection",
      status: "open",
      partnerStatus: "INIT",
      chain: req.chain,
      currency: req.currency,
      usdcAmount: usdc,
      fiatAmount: req.fiatAmount,
      rate: onRamp,
      virtualAccount: { bank: "Mock Bank", accountNumber: String(9_000_000_000 + Math.floor(Math.random() * 1e9)), accountName: "Corridor Mock (collection)" },
      recipient: req.recipient,
      reference: req.reference,
      createdAt: new Date(),
    };
    this.orders.set(order.id, order);
    await this.emit(order);
    return { ...order };
  }

  async getOrder(id: string): Promise<PartnerOrder> {
    const o = this.orders.get(id);
    if (!o) throw new PartnerError(`unknown order ${id}`, this.id, 404);
    return { ...o };
  }

  /** Simulate the partner observing our USDC deposit on its funding address. */
  async observeFunding(id: string, txSignature: string): Promise<PartnerOrder> {
    const o = this.mustGet(id, "payout");
    await this.transition(o, "processing", txSignature);
    await this.transition(o, this.opts.failPayouts ? "failed" : "completed", txSignature);
    return { ...o };
  }

  /** Simulate the payer's bank transfer landing, then deliver USDC to the recipient. */
  async payerTransferred(id: string): Promise<PartnerOrder> {
    const o = this.mustGet(id, "collection");
    await this.transition(o, "processing");
    const sig = this.opts.sendUsdc ? await this.opts.sendUsdc(o.recipient!, o.usdcAmount, o.chain) : `mock_delivery_${randomUUID().slice(0, 8)}`;
    await this.transition(o, "completed", sig);
    return { ...o };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>, now?: Date): boolean {
    return verifyWebhookSignature(this.opts.webhookSecret, rawBody, header(headers, "x-paj-timestamp"), header(headers, "x-paj-signature"), now);
  }

  parseWebhook(rawBody: string): PartnerOrder {
    const j = JSON.parse(rawBody);
    return {
      ...j,
      usdcAmount: BigInt(j.usdcAmount),
      fiatAmount: BigInt(j.fiatAmount),
      createdAt: new Date(j.createdAt),
    };
  }

  private mustGet(id: string, kind: PartnerOrder["kind"]): PartnerOrder {
    const o = this.orders.get(id);
    if (!o || o.kind !== kind) throw new PartnerError(`unknown ${kind} order ${id}`, this.id, 404);
    return o;
  }

  private async transition(o: PartnerOrder, status: OrderStatus, txSignature?: string) {
    o.status = status;
    o.partnerStatus = PARTNER_STATUS[status];
    if (txSignature) o.txSignature = txSignature;
    await this.emit(o);
  }

  private async emit(o: PartnerOrder) {
    if (!this.opts.deliver) return;
    const body = JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    const ts = Math.floor(Date.now() / 1000);
    await this.opts.deliver(body, { "x-paj-timestamp": String(ts), "x-paj-signature": signWebhook(this.opts.webhookSecret, ts, body) });
  }
}

function toMinor(c: Fiat, amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** FIAT[c].decimals));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
