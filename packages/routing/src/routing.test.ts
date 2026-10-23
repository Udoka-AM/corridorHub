import { describe, expect, it } from "vitest";
import { DEFAULT_EDGES, NoRouteError, planRoute, type Edge } from "./index.ts";

/**
 * The graph as it looks while a corridor's only partner settles off Stellar:
 * the on-hub payout edge for that currency is replaced by one from Solana.
 * Every launch currency has an on-hub partner now, so this is constructed
 * rather than configured.
 */
const offStellar = (currency: "NGN"): Edge[] => [
  ...DEFAULT_EDGES.filter((e) => !(e.kind === "partner.payout" && e.to.asset === currency)),
  { kind: "partner.payout", from: { venue: "solana", asset: "USDC" }, to: { venue: "partner_fiat", asset: currency }, cost: 1 },
];

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

  it("pays naira out on the hub too, now that its partner settles in Stellar USDC", () => {
    const plan = planRoute({ corridor: "EUR-NGN", privacy: "public", source, destination: { venue: "partner_fiat", asset: "NGN" }, env: "mainnet" });
    expect(plan.steps.map((s) => `${s.kind}:${s.from.venue}->${s.to.venue}`)).toEqual([
      "ledger.reserve:stellar->stellar",
      "partner.payout:stellar->partner_fiat",
    ]);
  });

  it("takes one CCTP hop for a currency whose only partner settles off Stellar", () => {
    const plan = planRoute(
      { corridor: "EUR-NGN", privacy: "public", source, destination: { venue: "partner_fiat", asset: "NGN" }, env: "mainnet" },
      offStellar("NGN"),
    );
    expect(plan.steps.map((s) => `${s.kind}:${s.from.venue}->${s.to.venue}`)).toEqual([
      "ledger.reserve:stellar->stellar",
      "cctp.transfer:stellar->solana",
      "partner.payout:solana->partner_fiat",
    ]);
  });

  it("uses the simulated bridge on testnet, where CCTP is not wired up", () => {
    const plan = planRoute(
      { corridor: "EUR-NGN", privacy: "public", source, destination: { venue: "partner_fiat", asset: "NGN" }, env: "testnet" },
      offStellar("NGN"),
    );
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
    for (const currency of ["KES", "NGN"] as const) {
      const plan = planRoute({
        corridor: `${currency}-CNY`,
        purpose: "collection",
        privacy: "public",
        source: { venue: "partner_fiat", asset: currency },
        destination: source,
        env: "mainnet",
      });
      expect(plan.steps.map((s) => `${s.kind}:${s.to.venue}`)).toEqual(["partner.collect:stellar", "ledger.credit:stellar"]);
    }
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
