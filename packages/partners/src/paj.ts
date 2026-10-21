import { FIAT, decimal, type Fiat, type Hex, assetDecimals, parseMoney, rescale } from "@corridor/core";
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
import { header, verifyWebhookSignature } from "./webhook.ts";

/**
 * Paj (paj.cash) adapter, built against Paj Public API v2
 * (https://docs.paj.cash/api-reference/openapi.json).
 *
 * - Payout  = offramp order: Paj returns a one-off funding address; USDC sent
 *   there is paid out to the bank account.
 * - Collection = onramp order: Paj returns a one-off virtual bank account;
 *   once the payer transfers, Paj delivers USDC to our wallet.
 * - Status: INIT → PROCESSING → COMPLETED | ERROR, pushed by signed webhook.
 */

const USDC_MINT: Partial<Record<PartnerChain, string>> = {
  SOLANA: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const STATUS: Record<string, OrderStatus> = {
  INIT: "open",
  PENDDING: "open", // spelling as it appears in Paj's API reference examples
  PENDING: "open",
  PROCESSING: "processing",
  COMPLETED: "completed",
  ERROR: "failed",
};

/** Corridor Reference in Paj's free-text fields, so it is echoed back on webhooks. */
const REF_PREFIX = "corridor:";

export interface PajOptions {
  apiKey: string;
  /** `whsec_…` secret for verifying webhooks. */
  webhookSecret?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

type PajTx = Record<string, any>;

export class PajPartner implements RampPartner {
  readonly id = "paj";
  readonly payoutCurrencies = ["NGN", "GHS", "KES", "TZS", "ZAR"] as const satisfies readonly Fiat[];
  readonly collectionCurrencies = ["NGN"] as const satisfies readonly Fiat[];
  // Paj pays out and collects on Solana only for now (Oct 2026). Base appears in its API but is not live for Corridor.
  readonly chains = ["SOLANA"] as const satisfies readonly PartnerChain[];

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PajOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.paj.cash";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<any> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { "x-api-key": this.opts.apiKey, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new PartnerError(json.message ?? `Paj ${method} ${path} → ${res.status}`, this.id, res.status);
    return json;
  }

  async rates(currency: Fiat): Promise<Rates> {
    const r = await this.call("GET", `/pub/v2/rate?currency=${currency}`);
    return { currency, onRamp: decimal(r.onRampRate.rate), offRamp: decimal(r.offRampRate.rate), at: new Date(r.offRampRate.createdAt) };
  }

  private assertChain(chain: PartnerChain): void {
    if (!(this.chains as readonly PartnerChain[]).includes(chain)) {
      throw new PartnerError(`Paj does not settle on ${chain} for Corridor yet; use SOLANA`, this.id);
    }
  }

  async openPayout(req: PayoutRequest): Promise<PartnerOrder> {
    this.assertCurrency(req.currency, this.payoutCurrencies);
    this.assertChain(req.chain);
    const tx = await this.call("POST", "/pub/v2/offramp", {
      accountNumber: req.beneficiary.accountNumber,
      bankCode: req.beneficiary.bankCode,
      currency: req.currency,
      amount: usdcToNumber(req.usdcAmount),
      chain: req.chain,
      mint: USDC_MINT[req.chain],
      webhookURL: req.webhookUrl,
      description: `${REF_PREFIX}${req.reference.slice(2)}`,
    });
    return this.normalise(tx, "payout", req.reference);
  }

  async openCollection(req: CollectionRequest): Promise<PartnerOrder> {
    this.assertCurrency(req.currency, this.collectionCurrencies);
    this.assertChain(req.chain);
    const tx = await this.call("POST", "/pub/v2/onramp", {
      fiatAmount: minorToNumber(req.currency, req.fiatAmount),
      currency: req.currency,
      recipient: req.recipient,
      chain: req.chain,
      mint: USDC_MINT[req.chain],
      webhookURL: req.webhookUrl,
      userExternalId: `${REF_PREFIX}${req.reference.slice(2)}`,
    });
    return this.normalise(tx, "collection", req.reference);
  }

  async getOrder(id: string): Promise<PartnerOrder> {
    return this.normalise(await this.call("GET", `/pub/v2/transaction/${encodeURIComponent(id)}`));
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>, now?: Date): boolean {
    if (!this.opts.webhookSecret) return false;
    return verifyWebhookSignature(
      this.opts.webhookSecret,
      rawBody,
      header(headers, "x-paj-timestamp"),
      header(headers, "x-paj-signature"),
      now,
    );
  }

  parseWebhook(rawBody: string): PartnerOrder {
    return this.normalise(JSON.parse(rawBody));
  }

  private normalise(tx: PajTx, kind?: "payout" | "collection", reference?: Hex): PartnerOrder {
    const currency = String(tx.currency) as Fiat;
    const type = String(tx.transactionType ?? "");
    const resolvedKind = kind ?? (type === "ON_RAMP" ? "collection" : "payout");
    const echoed = [tx.description, tx.userExternalId]
      .map((v) => (typeof v === "string" && v.startsWith(REF_PREFIX) ? (`0x${v.slice(REF_PREFIX.length)}` as Hex) : undefined))
      .find(Boolean);
    return {
      partner: this.id,
      id: String(tx.id),
      kind: resolvedKind,
      status: STATUS[String(tx.status)] ?? "open",
      partnerStatus: String(tx.status),
      chain: (String(tx.chain ?? "SOLANA") as PartnerChain),
      currency,
      usdcAmount: numberToUsdc(tx.usdcAmount ?? tx.amount ?? 0),
      fiatAmount: numberToMinor(currency, tx.fiatAmount ?? 0),
      rate: decimal(tx.rate ?? 0),
      fundingAddress: resolvedKind === "payout" ? tx.address : undefined,
      virtualAccount:
        resolvedKind === "collection" && tx.accountNumber
          ? { bank: String(tx.bank), accountNumber: String(tx.accountNumber), accountName: String(tx.accountName) }
          : undefined,
      recipient: tx.recipient,
      txSignature: tx.signature || undefined,
      reference: reference ?? echoed,
      createdAt: new Date(tx.createdAt ?? Date.now()),
    };
  }

  private assertCurrency(c: Fiat, allowed: readonly Fiat[]) {
    if (!allowed.includes(c)) throw new PartnerError(`Paj does not support ${c} for this direction`, this.id);
  }
}

// Paj uses decimal numbers on the wire; Corridor uses integer minor units.
// Paj settles on Solana, where USDC has 6 decimals, so an amount carrying a
// seventh is not payable: `rescale` refuses it rather than rounding it away.
const USDC_DP = assetDecimals("USDC");
const SOLANA_USDC_DP = 6;

function usdcToNumber(base: bigint): number {
  return Number(rescale(base, USDC_DP, SOLANA_USDC_DP)) / 10 ** SOLANA_USDC_DP;
}
function numberToUsdc(n: number | string): bigint {
  return parseMoney("USDC", decimal(n), { truncate: true }).amount;
}
function minorToNumber(c: Fiat, minor: bigint): number {
  return Number(minor) / 10 ** FIAT[c].decimals;
}
function numberToMinor(c: Fiat, n: number | string): bigint {
  return parseMoney(c, decimal(n), { truncate: true }).amount;
}
