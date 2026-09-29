import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { RefKind, customerTag, encodeRef, uuidv7 } from "@corridor/core";
import { openLocalDb } from "@corridor/ledger";
import { MockPartner, PartnerRegistry, signWebhook } from "@corridor/partners";
import { PartnerEventStore, handlePartnerWebhook, partnerObservation, webhookServer } from "./index.ts";

const SECRET = "whsec_test";
const ref = encodeRef({ kind: RefKind.Payout, corridor: "EUR-NGN", shielded: false, id: uuidv7(), customerTag: customerTag("zynta", "s") });

let db: Awaited<ReturnType<typeof openLocalDb>>;
let store: PartnerEventStore;
beforeEach(async () => {
  db = await openLocalDb();
  store = await PartnerEventStore.open(db);
});
afterEach(() => db.close());

describe("partner webhook ingest", () => {
  it("records each status once, rejects forgeries, and tracks the latest status", async () => {
    const deliveries: [string, Record<string, string>][] = [];
    const mock = new MockPartner({ webhookSecret: SECRET, deliver: async (b, h) => void deliveries.push([b, h]) });
    const registry = new PartnerRegistry().register(mock);
    const order = await mock.openPayout({ currency: "NGN", chain: "SOLANA", usdcAmount: 7_000_000n, beneficiary: { bankCode: "058", accountNumber: "1" }, reference: ref });
    await mock.observeFunding(order.id, "sig");

    const results = [];
    for (const [body, headers] of deliveries) results.push(await handlePartnerWebhook(registry, store, "mock", body, headers));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await store.latest("mock", order.id)).toBe("completed");

    // Redelivery: accepted (so the partner stops retrying) but not re-recorded.
    const [body, headers] = deliveries.at(-1)!;
    expect(await handlePartnerWebhook(registry, store, "mock", body, headers)).toMatchObject({ status: 200, fresh: false });

    // Forged body with a stale signature: rejected.
    const forged = body.replace('"completed"', '"failed"');
    expect((await handlePartnerWebhook(registry, store, "mock", forged, headers)).status).toBe(401);
    expect((await handlePartnerWebhook(registry, store, "nobody", body, headers)).status).toBe(404);
  });

  it("turns a completed order into a reconciliation observation", async () => {
    const mock = new MockPartner({ webhookSecret: SECRET });
    const o = await mock.openPayout({ currency: "NGN", chain: "SOLANA", usdcAmount: 7_000_000n, beneficiary: { bankCode: "058", accountNumber: "1" }, reference: ref });
    expect(partnerObservation(o)).toBeNull();
    const done = await mock.observeFunding(o.id, "sig");
    expect(partnerObservation(done)).toMatchObject({ venue: "partner_fiat", externalRef: `mock:${o.id}`, asset: "USDC", amount: 7_000_000n, reference: ref });
  });

  it("serves POST /webhooks/:partner over HTTP", async () => {
    const mock = new MockPartner({ webhookSecret: SECRET });
    const registry = new PartnerRegistry().register(mock);
    const server = webhookServer(registry, store).listen(0);
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    try {
      const o = await mock.openPayout({ currency: "NGN", chain: "SOLANA", usdcAmount: 1_000_000n, beneficiary: { bankCode: "058", accountNumber: "1" }, reference: ref });
      const body = JSON.stringify({ ...o, status: "processing", partnerStatus: "PROCESSING" }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      const ts = Math.floor(Date.now() / 1000);
      const ok = await fetch(`http://127.0.0.1:${port}/webhooks/mock`, {
        method: "POST",
        headers: { "X-PAJ-Timestamp": String(ts), "X-PAJ-Signature": signWebhook(SECRET, ts, body) },
        body,
      });
      expect(ok.status).toBe(200);
      expect(await store.latest("mock", o.id)).toBe("processing");
      const bad = await fetch(`http://127.0.0.1:${port}/webhooks/mock`, { method: "POST", body });
      expect(bad.status).toBe(401);
    } finally {
      server.close();
    }
  });
});
