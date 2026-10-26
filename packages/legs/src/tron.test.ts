import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { solanaAddressOfStellar } from "@corridor/bridge-cctp";
import { ManualReviewError, NonRetryableError } from "@corridor/saga";
import { OneClick, type SwapStatus } from "@corridor/swap-intents";
import { assertDelivered, planTronDeposit, quoteTronDeposit } from "./tron.ts";

const QUOTE = {
  quote: {
    amountIn: "150000000",
    amountOut: "149767242",
    minAmountOut: "148269569",
    amountInUsd: "149.88",
    amountOutUsd: "149.73",
    timeEstimate: 77,
    deadline: "2026-10-26T12:17:37.545Z",
    depositAddress: "TWd4JxMVfwRTqtPEAjNRMBXvAUPuTqy4tL",
  },
  signature: "ed25519:sig",
  correlationId: "c-1",
};

function oneClick(body: unknown = QUOTE) {
  const calls: Record<string, unknown>[] = [];
  const http = vi.fn(async (_input: unknown, init?: RequestInit) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : {});
    return new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } });
  });
  return { client: new OneClick({ fetch: http as unknown as typeof fetch }), calls };
}

const TRON = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";

describe("planning a Tron deposit", () => {
  it("pays the swap out to the user's own Solana address, the same key as their Stellar account", async () => {
    const account = Keypair.random().publicKey();
    const { client, calls } = oneClick();
    const plan = await planTronDeposit({ oneClick: client, stellarAccount: account, amount: 150_000_000n, refundTo: TRON });

    // The recipient is the user's key on Solana — never Corridor's, and never
    // the G… account, which Solana would not accept.
    expect(calls[0]!.recipient).toBe(solanaAddressOfStellar(account));
    expect(calls[0]!.recipient).not.toBe(account);
    expect(plan.solanaAddress).toBe(solanaAddressOfStellar(account));
    expect(plan.stellarAccount).toBe(account);
  });

  it("refunds to the user's Tron address, so an unfilled swap goes back where it came from", async () => {
    const { client, calls } = oneClick();
    await planTronDeposit({
      oneClick: client,
      stellarAccount: Keypair.random().publicKey(),
      amount: 150_000_000n,
      refundTo: TRON,
    });
    expect(calls[0]!.refundTo).toBe(TRON);
    expect(calls[0]!.refundType).toBe("ORIGIN_CHAIN");
  });

  it("hands back the deposit address, the amounts and when it stops being good for", async () => {
    const { client } = oneClick();
    const plan = await planTronDeposit({
      oneClick: client,
      stellarAccount: Keypair.random().publicKey(),
      amount: 150_000_000n,
      refundTo: TRON,
    });
    expect(plan).toMatchObject({
      depositAddress: "TWd4JxMVfwRTqtPEAjNRMBXvAUPuTqy4tL",
      amount: 150_000_000n,
      expectedUsdc: 149_767_242n,
      minUsdc: 148_269_569n,
      expiresAt: "2026-10-26T12:17:37.545Z",
      timeEstimateSeconds: 77,
      quoteSignature: "ed25519:sig",
    });
  });

  it("asks for a live quote when planning and a dry one when only showing a rate", async () => {
    const planning = oneClick();
    await planTronDeposit({
      oneClick: planning.client,
      stellarAccount: Keypair.random().publicKey(),
      amount: 150_000_000n,
      refundTo: TRON,
    });
    expect(planning.calls[0]!.dry).toBe(false);

    const showing = oneClick();
    const rate = await quoteTronDeposit({
      oneClick: showing.client,
      stellarAccount: Keypair.random().publicKey(),
      amount: 150_000_000n,
      refundTo: TRON,
    });
    expect(showing.calls[0]!.dry).toBe(true);
    expect(rate).toEqual({ expectedUsdc: 149_767_242n, minUsdc: 148_269_569n, timeEstimateSeconds: 77 });
  });

  it("will not plan a deposit below the solver network's floor", async () => {
    const { client, calls } = oneClick();
    await expect(
      planTronDeposit({ oneClick: client, stellarAccount: Keypair.random().publicKey(), amount: 40_000_000n, refundTo: TRON }),
    ).rejects.toThrow(/\$100/);
    expect(calls).toHaveLength(0);
  });
});

function status(state: string, extra: Partial<SwapStatus> = {}): SwapStatus {
  return { state: state as SwapStatus["state"], originTxs: [], destinationTxs: [], ...extra };
}

const D = { depositAddress: "TWd4JxMVfwRTqtPEAjNRMBXvAUPuTqy4tL", refundTo: TRON };

describe("deciding what a settled swap means", () => {
  it("accepts a fill that has both an amount and a payout", () => {
    expect(() => assertDelivered(status("SUCCESS", { amountOut: 149_767_242n, destinationTxs: ["sol-tx"] }), D)).not.toThrow();
  });

  it("sends a refund down the dead end rather than retrying against money that has gone back", () => {
    // Retrying would re-quote at a new rate against funds no longer there.
    const e = assertThrows(() => assertDelivered(status("REFUNDED", { refundedAmount: 148_295_028n }), D));
    expect(e).toBeInstanceOf(NonRetryableError);
    expect(e.message).toContain(TRON);
  });

  it("reports the refund at Tron's six decimals, not the ledger's seven", () => {
    // 148295028 base units is 148.295028 USDT on Tron. Read at the ledger's
    // scale it would say 14.8295028 — ten times too small.
    const e = assertThrows(() => assertDelivered(status("REFUNDED", { refundedAmount: 148_295_028n }), D));
    expect(e.message).toContain("148.295028 USDT");
    expect(e.message).not.toContain("14.8295028");
  });

  it("treats a short deposit as a human's problem, because nothing will move it", () => {
    const e = assertThrows(() => assertDelivered(status("INCOMPLETE_DEPOSIT"), D));
    expect(e).toBeInstanceOf(ManualReviewError);
    expect(e.message).toMatch(/without filling or refunding/);
  });

  it("does not retry a swap the solvers could not fill", () => {
    expect(assertThrows(() => assertDelivered(status("FAILED"), D))).toBeInstanceOf(NonRetryableError);
  });

  it("refuses a success that is missing the things a success must have", () => {
    // A SUCCESS with no amount or no payout transaction would otherwise be
    // booked as a delivery nobody can point at.
    expect(assertThrows(() => assertDelivered(status("SUCCESS", { destinationTxs: ["sol-tx"] }), D))).toBeInstanceOf(ManualReviewError);
    expect(assertThrows(() => assertDelivered(status("SUCCESS", { amountOut: 1n }), D))).toBeInstanceOf(ManualReviewError);
  });

  it("asks for a human when 1Click reports a state Corridor has not been taught", () => {
    const e = assertThrows(() => assertDelivered(status("SETTLED_SOMEHOW"), D));
    expect(e).toBeInstanceOf(ManualReviewError);
    expect(e.message).toContain("SETTLED_SOMEHOW");
  });
});

function assertThrows(fn: () => void): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected this to throw, and it did not");
}
