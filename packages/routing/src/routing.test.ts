import { describe, expect, it } from "vitest";
import { NoRouteError, planRoute } from "./index.ts";

const source = { venue: "tempo", asset: "pathUSD" } as const;

describe("route planner", () => {
  it("routes a public mainnet payout through Across in two hops via Base", () => {
    const plan = planRoute({ corridor: "EUR-NGN", privacy: "public", source, destination: { venue: "partner_fiat", asset: "NGN" }, env: "mainnet" });
    expect(plan.steps.map((s) => `${s.kind}:${s.to.venue}`)).toEqual([
      "ledger.reserve:tempo",
      "across.bridge:base",
      "across.bridge:solana",
      "partner.payout:partner_fiat",
    ]);
    expect(plan.steps.every((s) => s.referenceScope === "payout")).toBe(true);
  });

  it("uses the simulated bridge on testnet, where Across has no Tempo deployment", () => {
    const plan = planRoute({ corridor: "EUR-NGN", privacy: "public", source, destination: { venue: "partner_fiat", asset: "NGN" }, env: "testnet" });
    expect(plan.steps.map((s) => s.kind)).toEqual(["ledger.reserve", "bridge.simulated", "partner.payout"]);
  });

  it("routes a shielded payout into the Ironwood pool through the same graph", () => {
    const plan = planRoute({ corridor: "USD-USD", privacy: "shielded", source, destination: { venue: "zcash_ironwood", asset: "ZEC" }, env: "testnet" });
    expect(plan.steps.map((s) => s.kind)).toEqual(["ledger.reserve", "near.swap", "zcash.shieldedBatch"]);
  });

  it("never puts per-recipient references on public legs of a shielded route", () => {
    const plan = planRoute({ corridor: "USD-USD", privacy: "shielded", source, destination: { venue: "zcash_ironwood", asset: "ZEC" }, env: "testnet" });
    const scopes = Object.fromEntries(plan.steps.map((s) => [s.kind, s.referenceScope]));
    expect(scopes).toEqual({ "ledger.reserve": "batch", "near.swap": "batch", "zcash.shieldedBatch": "item" });
  });

  it("converts other Tempo stablecoins to pathUSD first", () => {
    const plan = planRoute({
      corridor: "EUR-NGN",
      privacy: "public",
      source: { venue: "tempo", asset: "USDC.e" },
      destination: { venue: "partner_fiat", asset: "NGN" },
      env: "testnet",
    });
    expect(plan.steps[1]?.kind).toBe("tempo.dexSwap");
  });

  it("rejects mismatched privacy and destination", () => {
    expect(() =>
      planRoute({ corridor: "EUR-NGN", privacy: "shielded", source, destination: { venue: "partner_fiat", asset: "NGN" }, env: "testnet" }),
    ).toThrow(NoRouteError);
    expect(() =>
      planRoute({ corridor: "EUR-NGN", privacy: "public", source, destination: { venue: "zcash_ironwood", asset: "ZEC" }, env: "testnet" }),
    ).toThrow(NoRouteError);
  });

  it("routes an import payment from a Nigerian importer's balance to a Chinese supplier", () => {
    const plan = planRoute({ corridor: "NGN-CNY", privacy: "public", source, destination: { venue: "partner_fiat", asset: "CNY" }, env: "mainnet" });
    expect(plan.purpose).toBe("payout");
    expect(plan.steps.map((s) => s.kind)).toEqual(["ledger.reserve", "across.bridge", "across.bridge", "partner.payout"]);
  });

  it("pays suppliers across Asia and the Americas from the same hub", () => {
    for (const asset of ["HKD", "INR", "AED", "USD", "BRL", "MXN"] as const) {
      const plan = planRoute({ corridor: `NGN-${asset}`, privacy: "public", source, destination: { venue: "partner_fiat", asset }, env: "testnet" });
      expect(plan.steps.at(-1)).toMatchObject({ kind: "partner.payout", to: { asset } });
    }
  });

  it("collects local currency into the Tempo hub and credits the customer", () => {
    const mainnet = planRoute({
      corridor: "NGN-CNY",
      purpose: "collection",
      privacy: "public",
      source: { venue: "partner_fiat", asset: "NGN" },
      destination: source,
      env: "mainnet",
    });
    expect(mainnet.steps.map((s) => `${s.kind}:${s.to.venue}`)).toEqual([
      "partner.collect:solana",
      "across.bridge:base",
      "across.bridge:tempo",
      "ledger.credit:tempo",
    ]);
    const testnet = planRoute({ ...mainnet, source: { venue: "partner_fiat", asset: "NGN" }, destination: source, env: "testnet" });
    expect(testnet.steps.map((s) => s.kind)).toEqual(["partner.collect", "bridge.simulated", "ledger.credit"]);
  });

  it("never lets a flow bypass the Tempo hub", () => {
    // A payout must be funded from the hub...
    expect(() =>
      planRoute({ corridor: "NGN-CNY", privacy: "public", source: { venue: "partner_fiat", asset: "NGN" }, destination: { venue: "partner_fiat", asset: "CNY" }, env: "mainnet" }),
    ).toThrow(/Tempo hub/);
    // ...and a collection must land on it.
    expect(() =>
      planRoute({ corridor: "NGN-USD", purpose: "collection", privacy: "public", source: { venue: "partner_fiat", asset: "NGN" }, destination: { venue: "solana", asset: "USDC" }, env: "mainnet" }),
    ).toThrow(/Tempo hub/);
  });

  it("supports a shielded supplier payment from an importer", () => {
    const plan = planRoute({ corridor: "NGN-CNY", privacy: "shielded", source, destination: { venue: "zcash_ironwood", asset: "ZEC" }, env: "testnet" });
    expect(plan.steps.map((s) => s.kind)).toEqual(["ledger.reserve", "near.swap", "zcash.shieldedBatch"]);
  });
});

