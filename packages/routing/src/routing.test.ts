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
    const plan = planRoute({ corridor: "USD-SHIELDED", privacy: "shielded", source, destination: { venue: "zcash_ironwood", asset: "ZEC" }, env: "testnet" });
    expect(plan.steps.map((s) => s.kind)).toEqual(["ledger.reserve", "near.swap", "zcash.shieldedBatch"]);
  });

  it("never puts per-recipient references on public legs of a shielded route", () => {
    const plan = planRoute({ corridor: "USD-SHIELDED", privacy: "shielded", source, destination: { venue: "zcash_ironwood", asset: "ZEC" }, env: "testnet" });
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
});
