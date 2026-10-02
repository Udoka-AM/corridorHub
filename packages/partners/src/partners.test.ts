import { describe, expect, it } from "vitest";
import { RefKind, customerTag, encodeRef, uuidv7 } from "@corridor/core";
import { MockPartner, PajPartner, PartnerRegistry, signWebhook, verifyWebhookSignature } from "./index.ts";

const ref = encodeRef({ kind: RefKind.Payout, corridor: "EUR-NGN", shielded: false, id: uuidv7(), customerTag: customerTag("eu-payco", "s") });

/** A Paj transaction shaped like the TransactionInterfaceDto in Paj's OpenAPI spec. */
function pajTx(over: Record<string, unknown> = {}) {
  return {
    id: "tx_123",
    address: "4KSLE7EU1P7PQ8Rc4hdb2ZKq2JmWHD8UXJp7guEdyT9j",
    signature: "",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    currency: "NGN",
    amount: 7,
    usdcAmount: 7,
    fiatAmount: 10710,
    sender: "",
    recipient: "",
    rate: 1530,
    status: "INIT",
    transactionType: "OFF_RAMP",
    createdAt: "2026-09-30T10:00:00.000Z",
    accountNumber: "0123456789",
    accountName: "ADA OBI",
    bank: "GTBank",
    fee: 0,
    chain: "SOLANA",
    description: `corridor:${ref.slice(2)}`,
    ...over,
  };
}

function recordingFetch(response: unknown, calls: { url: string; init: RequestInit }[]) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify(response) } as Response;
  }) as unknown as typeof fetch;
}

describe("webhook signatures (Paj scheme)", () => {
  const secret = "whsec_" + "ab".repeat(32);
  const body = '{"id":"pay_1","amount":25.5}';
  const now = new Date(1788224623 * 1000);

  it("accepts a fresh, correctly signed delivery", () => {
    const sig = signWebhook(secret, 1788224623, body);
    expect(verifyWebhookSignature(secret, body, "1788224623", sig, now)).toBe(true);
  });

  it("rejects tampering, the wrong secret and stale or replayed deliveries", () => {
    const sig = signWebhook(secret, 1788224623, body);
    expect(verifyWebhookSignature(secret, body.replace("25.5", "2550"), "1788224623", sig, now)).toBe(false);
    expect(verifyWebhookSignature("whsec_other", body, "1788224623", sig, now)).toBe(false);
    expect(verifyWebhookSignature(secret, body, "1788224623", sig, new Date((1788224623 + 301) * 1000))).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined, sig, now)).toBe(false);
  });

  it("matches on the v1 prefix during a scheme rotation", () => {
    const sig = signWebhook(secret, 1788224623, body);
    expect(verifyWebhookSignature(secret, body, "1788224623", `v2=deadbeef, ${sig}`, now)).toBe(true);
  });
});

describe("Paj adapter", () => {
  it("opens an offramp order with the Corridor Reference and returns the one-off funding address", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const paj = new PajPartner({ apiKey: "pk_test", fetchImpl: recordingFetch(pajTx(), calls) });
    const order = await paj.openPayout({
      currency: "NGN",
      chain: "SOLANA",
      usdcAmount: 7_000_000n,
      beneficiary: { bankCode: "058", accountNumber: "0123456789" },
      reference: ref,
    });
    expect(calls[0]!.url).toBe("https://api.paj.cash/pub/v2/offramp");
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("pk_test");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      accountNumber: "0123456789",
      bankCode: "058",
      currency: "NGN",
      amount: 7,
      chain: "SOLANA",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      description: `corridor:${ref.slice(2)}`,
    });
    expect(order).toMatchObject({ kind: "payout", status: "open", fundingAddress: "4KSLE7EU1P7PQ8Rc4hdb2ZKq2JmWHD8UXJp7guEdyT9j", usdcAmount: 7_000_000n, fiatAmount: 1_071_000n, reference: ref });
  });

  it("refuses Base, which Paj does not settle on for Corridor yet, before calling Paj", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const paj = new PajPartner({ apiKey: "k", fetchImpl: recordingFetch(pajTx({ chain: "BASE" }), calls) });
    await expect(
      paj.openPayout({ currency: "NGN", chain: "BASE", usdcAmount: 1_000_000n, beneficiary: { bankCode: "058", accountNumber: "1" }, reference: ref }),
    ).rejects.toThrow(/does not settle on BASE/);
    expect(calls).toHaveLength(0);
  });

  it("opens an onramp order and returns the virtual account for the payer", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const tx = pajTx({ transactionType: "ON_RAMP", accountNumber: "9912345678", accountName: "Paj Inc.(Pay NGN 15,600.00)", bank: "Wema", fiatAmount: 15600, usdcAmount: 10, recipient: "Recip1", description: undefined, userExternalId: `corridor:${ref.slice(2)}` });
    const paj = new PajPartner({ apiKey: "k", fetchImpl: recordingFetch(tx, calls) });
    const order = await paj.openCollection({ currency: "NGN", chain: "SOLANA", fiatAmount: 1_560_000n, recipient: "Recip1", reference: ref });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ fiatAmount: 15600, recipient: "Recip1", userExternalId: `corridor:${ref.slice(2)}` });
    expect(order).toMatchObject({ kind: "collection", virtualAccount: { bank: "Wema", accountNumber: "9912345678" }, usdcAmount: 10_000_000n, reference: ref });
  });

  it("normalises webhook status updates and recovers the reference from the echoed description", () => {
    const secret = "whsec_" + "cd".repeat(32);
    const paj = new PajPartner({ apiKey: "k", webhookSecret: secret });
    const body = JSON.stringify(pajTx({ status: "COMPLETED", signature: "5sig" }));
    const ts = Math.floor(Date.now() / 1000);
    expect(paj.verifyWebhook(body, { "X-PAJ-Timestamp": String(ts), "X-PAJ-Signature": signWebhook(secret, ts, body) })).toBe(true);
    expect(paj.parseWebhook(body)).toMatchObject({ status: "completed", partnerStatus: "COMPLETED", txSignature: "5sig", reference: ref });
    expect(paj.parseWebhook(JSON.stringify(pajTx({ status: "ERROR" }))).status).toBe("failed");
  });

  it("refuses currencies Paj does not serve in that direction", async () => {
    const paj = new PajPartner({ apiKey: "k", fetchImpl: recordingFetch({}, []) });
    await expect(
      paj.openPayout({ currency: "CNY", chain: "SOLANA", usdcAmount: 1n, beneficiary: { bankCode: "x", accountNumber: "y" }, reference: ref }),
    ).rejects.toThrow(/does not support CNY/);
  });
});

describe("mock partner", () => {
  it("runs the payout lifecycle and signs every webhook", async () => {
    const secret = "whsec_mock";
    const events: string[] = [];
    const mock = new MockPartner({
      webhookSecret: secret,
      deliver: async (body, headers) => {
        expect(verifyWebhookSignature(secret, body, headers["x-paj-timestamp"], headers["x-paj-signature"])).toBe(true);
        events.push(JSON.parse(body).partnerStatus);
      },
    });
    const order = await mock.openPayout({ currency: "NGN", chain: "SOLANA", usdcAmount: 7_000_000n, beneficiary: { bankCode: "058", accountNumber: "1" }, reference: ref });
    expect(order.fundingAddress).toBeDefined();
    expect(order.fiatAmount).toBe(1_071_000n); // 7 USDC × 1530
    const done = await mock.observeFunding(order.id, "sig123");
    expect(done.status).toBe("completed");
    expect(events).toEqual(["INIT", "PROCESSING", "COMPLETED"]);
  });

  it("delivers USDC to the recipient when a collection is paid", async () => {
    const sent: [string, bigint][] = [];
    const mock = new MockPartner({ webhookSecret: "s", sendUsdc: async (to, amt) => (sent.push([to, amt]), "deliverySig") });
    const o = await mock.openCollection({ currency: "NGN", chain: "SOLANA", fiatAmount: 1_560_000n, recipient: "HubWallet", reference: ref });
    expect(o.virtualAccount?.accountNumber).toMatch(/^9\d{9}$/);
    const done = await mock.payerTransferred(o.id);
    expect(sent).toEqual([["HubWallet", 10_000_000n]]); // ₦15,600 at 1,560 = 10 USDC
    expect(done).toMatchObject({ status: "completed", txSignature: "deliverySig" });
  });
});

describe("partner registry", () => {
  it("picks the partner that covers each spoke", () => {
    const paj = new PajPartner({ apiKey: "k" });
    const mock = new MockPartner({ webhookSecret: "s" });
    const reg = new PartnerRegistry().register(paj).register(mock);
    expect(reg.forPayout("NGN").id).toBe("paj");
    expect(reg.forPayout("CNY").id).toBe("mock");
    expect(reg.forCollection("NGN", "SOLANA").id).toBe("paj");
    expect(() => reg.forPayout("JPY")).toThrow(/no payout partner/);
  });
});
