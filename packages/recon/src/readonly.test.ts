import { describe, expect, it } from "vitest";
import type { Hex, Observation } from "@corridor/core";
import { exceptions, readOnlyCsv, reconcileReadOnly, summarizeReadOnly, type PayoutRecord } from "./readonly.ts";

const PAJ = "PajDeposit1111111111111111111111111111111111";
const T0 = new Date("2026-10-03T09:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const REF = `0x02${"ab".repeat(31)}` as Hex;

const obs = (o: Partial<Observation>): Observation => ({
  venue: "solana", externalRef: Math.random().toString(36).slice(2), reference: null, asset: "USDT", amount: 0n, observedAt: T0, ...o,
});
const rec = (r: Partial<PayoutRecord>): PayoutRecord => ({
  id: "p", venue: "solana", asset: "USDT", amount: 0n, counterparty: PAJ, direction: "out", createdAt: T0, ...r,
});

describe("read-only reconciliation", () => {
  it("matches by reference first, then by amount and counterparty, and flags the rest", () => {
    const records = [
      rec({ id: "by-ref", amount: 100_000_000n, reference: REF }),
      rec({ id: "exact", amount: 250_000_000n, createdAt: at(1) }),
      rec({ id: "short", amount: 75_000_000n, createdAt: at(2) }),
      rec({ id: "late", amount: 10_000_000n, createdAt: at(-120) }),
      rec({ id: "fresh", amount: 20_000_000n, createdAt: at(170) }),
    ];
    const observations = [
      obs({ externalRef: "sig-ref", reference: REF, amount: 100_000_000n, to: PAJ, asset: "USDC" }),
      obs({ externalRef: "sig-exact", amount: 250_000_000n, to: PAJ, observedAt: at(2) }),
      obs({ externalRef: "sig-short", amount: 74_900_000n, to: PAJ, observedAt: at(3) }),
      obs({ externalRef: "sig-unknown", amount: 5_000_000n, from: "Stranger111", to: "Treasury111", observedAt: at(4) }),
    ];
    const results = reconcileReadOnly(records, observations, { now: at(180) });
    const by = Object.fromEntries(results.filter((r) => r.record).map((r) => [r.record!.id, r]));

    expect(by["by-ref"]).toMatchObject({ status: "matched", matchedBy: "reference" });
    expect(by["exact"]).toMatchObject({ status: "matched", matchedBy: "amount_and_counterparty" });
    expect(by["short"]).toMatchObject({ status: "short", difference: -100_000n });
    expect(by["late"]!.status).toBe("missing");
    expect(by["fresh"]!.status).toBe("pending");
    expect(summarizeReadOnly(results)).toEqual({ matched: 2, short: 1, over: 0, pending: 1, missing: 1, unexpected: 1 });
    expect(exceptions(results).map((r) => r.record?.id ?? r.observation!.externalRef).sort()).toEqual(["late", "short", "sig-unknown"]);
  });

  it("never matches across assets or venues", () => {
    const results = reconcileReadOnly(
      [rec({ id: "usdt", amount: 1n })],
      [obs({ asset: "USDC", amount: 1n, to: PAJ }), obs({ venue: "base", amount: 1n, to: PAJ })],
      { now: at(60) },
    );
    expect(summarizeReadOnly(results)).toMatchObject({ matched: 0, missing: 1, unexpected: 2 });
  });

  it("exports integer minor units and escapes CSV cells", () => {
    const csv = readOnlyCsv(reconcileReadOnly([rec({ id: 'inv "7", NGN', amount: 5n })], [obs({ externalRef: "s", amount: 5n, to: PAJ })]));
    const [header, row] = csv.trim().split("\n");
    expect(header!.split(",")[0]).toBe("status");
    expect(row).toContain('"inv ""7"", NGN"');
    expect(row!.startsWith("matched,")).toBe(true);
  });
});
