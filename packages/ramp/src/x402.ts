import {
  PAYMENT_REQUIRED_CACHE_CONTROL,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import {
  DEFAULT_TOKEN_DECIMALS,
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  USDC_PUBNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
} from "@x402/stellar";

/**
 * x402 on the Ramp API: an agent pays per call.
 *
 * Corridor is the resource server here. It never parses the payment itself —
 * the agent signs Soroban authorization entries for a SEP-41 transfer and a
 * facilitator verifies and settles them, so the payload crosses this code
 * opaquely and the wire formats come from x402's own encoders rather than
 * from anything written here.
 *
 * The order matters: **verify before the work, settle after it succeeds.** A
 * payout that fails is not charged for, and a payment that cannot settle
 * never produces a payout.
 */

export const X402_VERSION = 2;

/** The two facilitator calls this needs. `HTTPFacilitatorClient` satisfies it. */
export interface FacilitatorClient {
  verify(paymentPayload: unknown, paymentRequirements: unknown): Promise<unknown>;
  settle(paymentPayload: unknown, paymentRequirements: unknown): Promise<unknown>;
}

export interface X402Options {
  /** The Stellar account paid for each call. */
  payTo: string;
  network: "testnet" | "mainnet";
  facilitator: FacilitatorClient;
  /** Public base URL this API is served at, for the `resource` field. */
  resourceBase: string;
  /**
   * Price per route, in the asset's base units — 7 decimals, the same as the
   * ledger. Keys are `"<METHOD> <path>"`, matching the server's own route
   * table; a route with no entry is not a paid route.
   */
  prices: Record<string, bigint>;
  /** SEP-41 token contract. Defaults to USDC on the chosen network. */
  asset?: string;
  maxTimeoutSeconds?: number;
}

/**
 * x402 v2 shapes. The amount is `amount` (v1 called it `maxAmountRequired`),
 * and the resource moved up to the envelope — so these are written against
 * the v2 types the encoders expect, and the compiler checks them.
 */
export interface PaymentRequirements {
  scheme: "exact";
  network: `${string}:${string}`;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
}

const CAIP2 = { testnet: STELLAR_TESTNET_CAIP2, mainnet: STELLAR_PUBNET_CAIP2 } as const;
const USDC = { testnet: USDC_TESTNET_ADDRESS, mainnet: USDC_PUBNET_ADDRESS } as const;

/** The decimals x402 prices are expressed in, which is the ledger's own. */
export const X402_DECIMALS = DEFAULT_TOKEN_DECIMALS;

export type ChargeOutcome =
  | { paid: false; status: 402; headers: Record<string, string>; body: unknown }
  | { paid: true; settle: () => Promise<Record<string, string>> };

export class X402Charger {
  constructor(private readonly opts: X402Options) {}

  /** The price for a route, or undefined when the route is free. */
  priceOf(method: string, path: string): bigint | undefined {
    return this.opts.prices[`${method} ${path}`];
  }

  requirements(args: { price: bigint }): PaymentRequirements {
    return {
      scheme: "exact",
      network: CAIP2[this.opts.network],
      asset: this.opts.asset ?? USDC[this.opts.network],
      amount: args.price.toString(),
      payTo: this.opts.payTo,
      maxTimeoutSeconds: this.opts.maxTimeoutSeconds ?? 120,
      extra: {},
    };
  }

  /** What is being paid for, which x402 v2 carries once per response. */
  resourceInfo(args: { method: string; path: string; description?: string }): ResourceInfo {
    return {
      url: `${this.opts.resourceBase.replace(/\/$/, "")}${args.path}`,
      description: args.description ?? `${args.method} ${args.path}`,
      mimeType: "application/json",
      serviceName: "Corridor Ramp",
    };
  }

  /**
   * Charge for one call.
   *
   * Without a payment signature the answer is a 402 carrying what to pay.
   * With one, the facilitator verifies it and the caller gets a `settle` to
   * run once the work has actually succeeded.
   */
  async charge(args: { method: string; path: string; price: bigint; signatureHeader?: string }): Promise<ChargeOutcome> {
    const requirements = this.requirements(args);
    const resource = this.resourceInfo(args);

    if (!args.signatureHeader) {
      return this.refuse(requirements, resource, `${args.method} ${args.path} costs ${requirements.amount} base units`);
    }

    let payload: unknown;
    try {
      payload = decodePaymentSignatureHeader(args.signatureHeader);
    } catch {
      return this.refuse(requirements, resource, "the PAYMENT-SIGNATURE header could not be read");
    }

    const verdict = (await this.opts.facilitator.verify(payload, requirements)) as { isValid?: boolean; invalidReason?: string } | undefined;
    if (verdict?.isValid === false) {
      return this.refuse(requirements, resource, verdict.invalidReason ?? "the facilitator rejected the payment");
    }

    return {
      paid: true,
      settle: async () => {
        const settled = await this.opts.facilitator.settle(payload, requirements);
        return { "payment-response": encodePaymentResponseHeader(settled as never) };
      },
    };
  }

  private refuse(requirements: PaymentRequirements, resource: ResourceInfo, error: string): ChargeOutcome {
    const payload = { x402Version: X402_VERSION, resource, accepts: [requirements], error };
    return {
      paid: false,
      status: 402,
      headers: {
        "payment-required": encodePaymentRequiredHeader(payload),
        "cache-control": PAYMENT_REQUIRED_CACHE_CONTROL,
      },
      body: payload,
    };
  }
}
