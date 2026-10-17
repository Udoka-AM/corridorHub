import { describe, expect, it } from "vitest";
import { NoRouteError, planRoute } from "./index.ts";

const source = { venue: "stellar", asset: "USDC" } as const;

describe("route planner", () => {
  it("pays out through a Stellar anchor without leaving the hub", () => {
    const plan = planRoute({ corridor: "EUR-KES", privacy: "public", source, destination: { venue: "partner_fiat", asset: "KES" }, env: "mainnet" });
    expect(plan.steps.map((s) => `${s.kind}:${s.from.venue}->${s.to.venue}`)).toEqual([
      "ledger.reserve:stellar->stellar",
      "partner.payout:stellar->partner_fiat",
    ]);
    expect(plan.steps.every((s) => s.referenceScope === "payout")).toBe(true);
  });

  it("opens the first three corridors as single-hop anchor payouts", () => {
    for (const asset of ["KES", "XOF", "TZS"] as const) {
      const plan = planRoute({ corridor: `EUR-${asset}`, privacy: "public", source, destination: { venue: "partner_fiat", asset }, env: "mainnet" });
      expect(plan.steps.map((s) => s.kind)).toEqual(["ledger.reserve", "partner.payout"]);
    }
  });

  it("takes one CCTP hop for naira, where the licensed partner settles on Solana", () => {
    const plan = planRoute({ corridor: "EUR-NGN", privacy: "public", source, destination: { venue: "partner_fiat", asset: "NGN" }, env: "mainnet" });
    expect(plan.steps.map((s) => `${s.kind}:${s.from.venue}->${s.to.venue}`)).toEqual([
      "ledger.reserve:stellar->stellar",
      "cctp.transfer:stellar->solana",
      "partner.payout:solana->partner_fiat",
    ]);
  });

  it("uses the simulated bridge on testnet, where CCTP is not wired up", () => {
    const plan = planRoute({ corridor: "EUR-NGN", privacy: "public", source, destination: { venue: "partner_fiat", asset: "NGN" }, env: "testnet" });
    expect(plan.steps.map((s) => s.kind)).toEqual(["ledger.reserve", "bridge.simulated", "partner.payout"]);
  });

  it("converts another issued stablecoin to USDC on Stellar's own order books first", () => {
    const plan = planRoute({
      corridor: "EUR-KES",
      privacy: "public",
      source: { venue: "stellar", asset: "EURC" },
      destination: { venue: "partner_fiat", asset: "KES" },
      env: "mainnet",
    });
    expect(plan.steps.map((s) => s.kind)).toEqual(["ledger.reserve", "stellar.pathPayment", "partner.payout"]);
  });

  it("refuses a shielded payout until the confidential lane is live", () => {
    expect(() =>
      planRoute({ corridor: "USD-USD", privacy: "shielded", source, destination: { venue: "partner_fiat", asset: "USD" }, env: "testnet" }),
    ).toThrow(/confidential lane is not live/);
  });

  it("routes an import payment from a Nigerian importer's balance to a Chinese supplier", () => {
    const plan = planRoute({ corridor: "NGN-CNY", privacy: "public", source, destination: { venue: "partner_fiat", asset: "CNY" }, env: "mainnet" });
    expect(plan.purpose).toBe("payout");
    expect(plan.steps.map((s) => s.kind)).toEqual(["ledger.reserve", "partner.payout"]);
  });

  it("pays suppliers across Asia and the Americas from the same hub", () => {
    for (const asset of ["HKD", "INR", "AED", "USD", "BRL", "MXN"] as const) {
      const plan = planRoute({ corridor: `NGN-${asset}`, privacy: "public", source, destination: { venue: "partner_fiat", asset }, env: "mainnet" });
      expect(plan.steps.at(-1)).toMatchObject({ kind: "partner.payout", to: { asset } });
    }
  });

  it("collects local currency into the Stellar hub and credits the customer", () => {
    const direct = planRoute({
      corridor: "KES-CNY",
      purpose: "collection",
      privacy: "public",
      source: { venue: "partner_fiat", asset: "KES" },
      destination: source,
      env: "mainnet",
    });
    expect(direct.steps.map((s) => `${s.kind}:${s.to.venue}`)).toEqual(["partner.collect:stellar", "ledger.credit:stellar"]);

    const viaSolana = planRoute({
      corridor: "NGN-CNY",
      purpose: "collection",
      privacy: "public",
      source: { venue: "partner_fiat", asset: "NGN" },
      destination: source,
      env: "mainnet",
    });
    expect(viaSolana.steps.map((s) => `${s.kind}:${s.to.venue}`)).toEqual([
      "partner.collect:solana",
      "cctp.transfer:stellar",
      "ledger.credit:stellar",
    ]);

    const testnet = planRoute({ ...viaSolana, source: { venue: "partner_fiat", asset: "NGN" }, destination: source, env: "testnet" });
    expect(testnet.steps.map((s) => s.kind)).toEqual(["partner.collect", "bridge.simulated", "ledger.credit"]);
  });

  it("never lets a flow bypass the Stellar hub", () => {
    // A payout must be funded from the hub...
    expect(() =>
      planRoute({ corridor: "NGN-CNY", privacy: "public", source: { venue: "partner_fiat", asset: "NGN" }, destination: { venue: "partner_fiat", asset: "CNY" }, env: "mainnet" }),
    ).toThrow(/Stellar hub/);
    // ...and a collection must land on it.
    expect(() =>
      planRoute({ corridor: "NGN-USD", purpose: "collection", privacy: "public", source: { venue: "partner_fiat", asset: "NGN" }, destination: { venue: "solana", asset: "USDC" }, env: "mainnet" }),
    ).toThrow(/Stellar hub/);
  });

  it("has no route to a currency no anchor covers", () => {
    expect(() =>
      planRoute({ corridor: "EUR-CHF", privacy: "public", source, destination: { venue: "partner_fiat", asset: "RWF" }, env: "mainnet" }),
    ).not.toThrow();
    expect(() =>
      planRoute({ corridor: "EUR-USD", privacy: "public", source, destination: { venue: "stellar", asset: "XLM" }, env: "mainnet" }),
    ).toThrow(NoRouteError);
  });
});
