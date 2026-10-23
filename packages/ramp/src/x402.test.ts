import { describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { STELLAR_TESTNET_CAIP2, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { Keypair } from "@stellar/stellar-sdk";
import { X402Charger, X402_VERSION, type FacilitatorClient } from "./x402.ts";

const payTo = Keypair.random().publicKey();

function facilitator(over: { isValid?: boolean; invalidReason?: string } = {}) {
  const calls: { name: string; requirements: Record<string, unknown> }[] = [];
  const client: FacilitatorClient = {
    async verify(_payload, requirements) {
      calls.push({ name: "verify", requirements: requirements as Record<string, unknown> });
      return { isValid: over.isValid ?? true, ...(over.invalidReason ? { invalidReason: over.invalidReason } : {}) };
    },
    async settle(_payload, requirements) {
      calls.push({ name: "settle", requirements: requirements as Record<string, unknown> });
      return { success: true, transaction: "abc", network: STELLAR_TESTNET_CAIP2, payer: "GPAYER" };
    },
  };
  return { client, calls };
}

const charger = (f: FacilitatorClient, prices: Record<string, bigint> = { "POST /v1/withdrawals": 10_000n }) =>
  new X402Charger({
    payTo,
    network: "testnet",
    facilitator: f,
    resourceBase: "https://ramp.corridor.test",
    prices,
  });

const route = { method: "POST", path: "/v1/withdrawals", price: 10_000n };

describe("x402 pricing", () => {
  it("prices only the routes it was given", () => {
    const c = charger(facilitator().client);
    expect(c.priceOf("POST", "/v1/withdrawals")).toBe(10_000n);
    expect(c.priceOf("GET", "/v1/withdrawals")).toBeUndefined();
    expect(c.priceOf("POST", "/v1/quotes")).toBeUndefined();
  });

  it("builds v2 requirements: the amount is `amount`, and USDC's own contract", () => {
    const r = charger(facilitator().client).requirements({ price: 10_000n });
    expect(r).toEqual({
      scheme: "exact",
      network: STELLAR_TESTNET_CAIP2,
      asset: USDC_TESTNET_ADDRESS,
      amount: "10000", // 0.001 USDC at 7 dp
      payTo,
      maxTimeoutSeconds: 120,
      extra: {},
    });
  });
});

describe("the 402", () => {
  it("says what to pay, in a header x402's own decoder reads back", async () => {
    const out = await charger(facilitator().client).charge(route);
    expect(out.paid).toBe(false);
    if (out.paid) return;

    expect(out.status).toBe(402);
    expect(out.headers["cache-control"]).toBe("no-store");

    const decoded = decodePaymentRequiredHeader(out.headers["payment-required"]!) as {
      x402Version: number;
      resource: { url: string; serviceName?: string };
      accepts: { amount: string; payTo: string }[];
      error?: string;
    };
    expect(decoded.x402Version).toBe(X402_VERSION);
    // The resource is carried once per response in v2, not per requirement.
    expect(decoded.resource.url).toBe("https://ramp.corridor.test/v1/withdrawals");
    expect(decoded.accepts[0]).toMatchObject({ amount: "10000", payTo });
    expect(decoded.error).toMatch(/costs 10000 base units/);
  });

  it("does not charge a free route", async () => {
    const f = facilitator();
    const c = charger(f.client, {});
    expect(c.priceOf("POST", "/v1/withdrawals")).toBeUndefined();
    expect(f.calls).toEqual([]);
  });
});

describe("a presented payment", () => {
  const signature = () =>
    encodePaymentSignatureHeader({
      x402Version: X402_VERSION,
      accepted: {
        scheme: "exact",
        network: STELLAR_TESTNET_CAIP2,
        asset: USDC_TESTNET_ADDRESS,
        amount: "10000",
        payTo,
        maxTimeoutSeconds: 120,
        extra: {},
      },
      payload: { authEntries: ["opaque"] },
    } as never);

  it("verifies before the work and settles only after, in that order", async () => {
    const f = facilitator();
    const out = await charger(f.client).charge({ ...route, signatureHeader: signature() });
    expect(out.paid).toBe(true);
    if (!out.paid) return;

    // Verified, and nothing settled yet: the work has not run.
    expect(f.calls.map((c) => c.name)).toEqual(["verify"]);

    const headers = await out.settle();
    expect(f.calls.map((c) => c.name)).toEqual(["verify", "settle"]);
    expect(headers["payment-response"]).toBeTruthy();
    // The same requirements go to both calls.
    expect(f.calls[0]!.requirements).toEqual(f.calls[1]!.requirements);
  });

  it("refuses when the facilitator says the payment is not valid, and settles nothing", async () => {
    const f = facilitator({ isValid: false, invalidReason: "insufficient_funds" });
    const out = await charger(f.client).charge({ ...route, signatureHeader: signature() });
    expect(out.paid).toBe(false);
    if (out.paid) return;

    const decoded = decodePaymentRequiredHeader(out.headers["payment-required"]!) as { error?: string };
    expect(decoded.error).toBe("insufficient_funds");
    expect(f.calls.map((c) => c.name)).toEqual(["verify"]);
  });

  it("refuses a header it cannot read, without calling the facilitator", async () => {
    const f = facilitator();
    const out = await charger(f.client).charge({ ...route, signatureHeader: "not-base64-json!!" });
    expect(out.paid).toBe(false);
    if (out.paid) return;
    const decoded = decodePaymentRequiredHeader(out.headers["payment-required"]!) as { error?: string };
    expect(decoded.error).toMatch(/could not be read/);
    expect(f.calls).toEqual([]);
  });
});
