import type { Fiat, Hex } from "@corridor/core";

/**
 * A ramp partner is a spoke of the network: it pays local currency out
 * against USDC (payout / offramp) and collects local currency into USDC
 * (collection / onramp). Every partner is normalised to this interface so
 * legs, webhooks and reconciliation never depend on one provider's API.
 *
 * A Stellar anchor speaks SEPs rather than a bespoke REST API, and
 * `SepAnchor` in ./sep.ts implements this same interface over SEP-10/12/31/38
 * — so an anchor and a cross-chain partner are interchangeable to the legs.
 */

export type PartnerChain = "STELLAR" | "SOLANA" | "BASE";

export type OrderStatus = "open" | "processing" | "completed" | "failed";

export interface Beneficiary {
  bankCode: string;
  accountNumber: string;
  /** Returned by the partner on registration; shown to the user to confirm. */
  accountName?: string;
}

export interface VirtualAccount {
  bank: string;
  accountNumber: string;
  accountName: string;
}

export interface PartnerOrder {
  partner: string;
  id: string;
  kind: "payout" | "collection";
  status: OrderStatus;
  /** Partner's own status string, kept for audit. */
  partnerStatus: string;
  chain: PartnerChain;
  currency: Fiat;
  /** USDC in base units (6 dp). */
  usdcAmount: bigint;
  /** Local currency in minor units. */
  fiatAmount: bigint;
  /** Local currency per USD at pricing time. */
  rate: number;
  /** Payout: where to send USDC. One-off; only valid for this order. */
  fundingAddress?: string;
  /** Collection: where the payer sends local currency. */
  virtualAccount?: VirtualAccount;
  /** Collection: wallet the partner delivers USDC to. */
  recipient?: string;
  /** On-chain signature of the partner's leg (deposit seen / token delivered), when known. */
  txSignature?: string;
  /** Corridor Reference carried in the partner's free-text field, if echoed back. */
  reference?: Hex;
  createdAt: Date;
}

export interface PayoutRequest {
  currency: Fiat;
  chain: PartnerChain;
  usdcAmount: bigint;
  beneficiary: Beneficiary;
  reference: Hex;
  webhookUrl?: string;
}

export interface CollectionRequest {
  currency: Fiat;
  chain: PartnerChain;
  /** Local-currency amount the payer will transfer, in minor units. */
  fiatAmount: bigint;
  /** Corridor wallet that receives the USDC. */
  recipient: string;
  reference: Hex;
  webhookUrl?: string;
}

export interface Rates {
  currency: Fiat;
  /** Local currency per USD when collecting (payer buys USDC). */
  onRamp: number;
  /** Local currency per USD when paying out. */
  offRamp: number;
  at: Date;
}

export interface RampPartner {
  readonly id: string;
  readonly payoutCurrencies: readonly Fiat[];
  readonly collectionCurrencies: readonly Fiat[];
  readonly chains: readonly PartnerChain[];

  rates(currency: Fiat): Promise<Rates>;
  openPayout(req: PayoutRequest): Promise<PartnerOrder>;
  openCollection(req: CollectionRequest): Promise<PartnerOrder>;
  getOrder(id: string): Promise<PartnerOrder>;

  /** Authenticate a webhook delivery from its raw body and headers. */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>, now?: Date): boolean;
  /** Normalise a verified webhook body. */
  parseWebhook(rawBody: string): PartnerOrder;
}

export class PartnerError extends Error {
  constructor(message: string, readonly partner: string, readonly status?: number) {
    super(message);
  }
}
