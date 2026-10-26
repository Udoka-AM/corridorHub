import { describe, expect, it, vi } from "vitest";
import { INTENT_ASSETS, MIN_SWAP_USD } from "./assets.ts";
import { OneClick, OneClickError, isTerminal, type SwapState } from "./oneclick.ts";

/** A quote body shaped like the one the live API returns. */
const QUOTE = {
  quote: {
    amountIn: "150000000",
    amountInFormatted: "150.0",
    amountInUsd: "149.884950000000",
    minAmountIn: "150000000",
    amountOut: "149767242",
    amountOutFormatted: "149.767242",
    amountOutUsd: "149.733694137792",
    minAmountOut: "148269569",
    timeEstimate: 77,
    deadline: "2026-10-26T12:17:37.545Z",
    depositAddress: "TWd4JxMVfwRTqtPEAjNRMBXvAUPuTqy4tL",
  },
  signature: "ed25519:RwqX1ez5pPMK",
  correlationId: "5b074e7e-8d34-4d8f-ba1f-6e0b0a424ebf",
};

function stub(replies: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; body: Record<string, unknown> | undefined }[] = [];
  const http = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const { status, body } = replies(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { http: http as unknown as typeof fetch, calls, count: () => http.mock.calls.length };
}

const REQ = {
  origin: "tron:USDT",
  destination: "solana:USDC",
  amount: 150_000_000n,
  recipient: "8y6VZ5L8aQHVSpf2NhW8soP9yKM14HuFpqPqyAuoAUgB",
  refundTo: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC",
} as const;

describe("quoting a swap", () => {
  it("names the assets by their 1Click ids and the chains as origin and destination", async () => {
    const s = stub(() => ({ status: 201, body: QUOTE }));
    await new OneClick({ fetch: s.http }).quote(REQ);
    expect(s.calls[0]!.url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(s.calls[0]!.body).toMatchObject({
      originAsset: INTENT_ASSETS["tron:USDT"].id,
      destinationAsset: INTENT_ASSETS["solana:USDC"].id,
      depositType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      refundType: "ORIGIN_CHAIN",
      swapType: "EXACT_INPUT",
      amount: "150000000",
      recipient: REQ.recipient,
      refundTo: REQ.refundTo,
      dry: false,
    });
  });

  it("reads the amounts as base units, not as formatted decimals", async () => {
    const s = stub(() => ({ status: 201, body: QUOTE }));
    const quote = await new OneClick({ fetch: s.http }).quote(REQ);
    expect(quote.amountOut).toBe(149_767_242n);
    expect(quote.minAmountOut).toBe(148_269_569n);
    expect(quote.amountIn).toBe(150_000_000n);
    expect(quote.depositAddress).toBe("TWd4JxMVfwRTqtPEAjNRMBXvAUPuTqy4tL");
    expect(quote.timeEstimateSeconds).toBe(77);
  });

  it("asks for a dry quote without a deposit address and does not mind getting none", async () => {
    const { depositAddress, ...priced } = QUOTE.quote;
    const s = stub(() => ({ status: 201, body: { ...QUOTE, quote: priced } }));
    const quote = await new OneClick({ fetch: s.http }).quote(REQ, { dry: true });
    expect(s.calls[0]!.body).toMatchObject({ dry: true });
    expect(quote.depositAddress).toBeUndefined();
    expect(quote.amountOut).toBe(149_767_242n);
  });

  it("refuses a live quote that came back with no deposit address", async () => {
    const { depositAddress, ...priced } = QUOTE.quote;
    const s = stub(() => ({ status: 201, body: { ...QUOTE, quote: priced } }));
    await expect(new OneClick({ fetch: s.http }).quote(REQ)).rejects.toThrow(/no deposit address/);
  });

  it("refuses an amount under the swap floor without calling out at all", async () => {
    const s = stub(() => ({ status: 201, body: QUOTE }));
    await expect(new OneClick({ fetch: s.http }).quote({ ...REQ, amount: 50_000_000n })).rejects.toThrow(
      new RegExp(`will not swap less than \\$${MIN_SWAP_USD}`),
    );
    expect(s.count()).toBe(0);
  });

  it("passes the solver network's own refusal through instead of guessing", async () => {
    // The live API's wording when the floor moves; Corridor must not replace it.
    const message = "Temporary swap limits: minimum swap amount is $100";
    const s = stub(() => ({ status: 400, body: { message, error: "Bad Request", statusCode: 400 } }));
    await expect(new OneClick({ fetch: s.http }).quote({ ...REQ, amount: 101_000_000n })).rejects.toThrow(message);
  });

  it("marks a rate limit retryable and a bad request not", async () => {
    const limited = stub(() => ({ status: 429, body: { message: "slow down" } }));
    await expect(new OneClick({ fetch: limited.http }).quote(REQ)).rejects.toMatchObject({ retryable: true });
    const refused = stub(() => ({ status: 400, body: { message: "unroutable pair" } }));
    await expect(new OneClick({ fetch: refused.http }).quote(REQ)).rejects.toMatchObject({ retryable: false });
  });

  it("rejects an amount that is not base units rather than coercing it", async () => {
    const s = stub(() => ({ status: 201, body: { ...QUOTE, quote: { ...QUOTE.quote, amountOut: "149.767242" } } }));
    await expect(new OneClick({ fetch: s.http }).quote(REQ)).rejects.toThrow(/not base units/);
  });
});

const DEPOSIT = "TWd4JxMVfwRTqtPEAjNRMBXvAUPuTqy4tL";

function statusBody(status: string, details: Record<string, unknown> = {}) {
  return {
    correlationId: "c-1",
    status,
    updatedAt: "2026-10-26T12:20:00.000Z",
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: [],
      ...details,
    },
  };
}

describe("reading a swap's status", () => {
  it("treats an unknown deposit address as not seen yet, not as an error", async () => {
    const s = stub(() => ({ status: 404, body: { message: `Deposit address ${DEPOSIT} not found` } }));
    await expect(new OneClick({ fetch: s.http }).status(DEPOSIT)).resolves.toBeUndefined();
  });

  it("pulls the delivered amount and both chains' transactions out of swapDetails", async () => {
    const s = stub(() => ({
      status: 200,
      body: statusBody("SUCCESS", {
        amountOut: "149767242",
        originChainTxHashes: [{ hash: "tron-tx", explorerUrl: "https://tronscan.org/#/transaction/tron-tx" }],
        destinationChainTxHashes: [{ hash: "sol-tx", explorerUrl: "https://explorer.solana.com/tx/sol-tx" }],
      }),
    }));
    const status = await new OneClick({ fetch: s.http }).status(DEPOSIT);
    expect(s.calls[0]!.url).toContain(`/status?depositAddress=${DEPOSIT}`);
    expect(status).toMatchObject({ state: "SUCCESS", amountOut: 149_767_242n, originTxs: ["tron-tx"], destinationTxs: ["sol-tx"] });
  });

  it("reads the refunded amount when the swap went back", async () => {
    const s = stub(() => ({ status: 200, body: statusBody("REFUNDED", { refundedAmount: "148295028" }) }));
    const status = await new OneClick({ fetch: s.http }).status(DEPOSIT);
    expect(status).toMatchObject({ state: "REFUNDED", refundedAmount: 148_295_028n });
  });

  it("knows which states it will not see move again", () => {
    const settled: SwapState[] = ["SUCCESS", "REFUNDED", "FAILED"];
    const moving: SwapState[] = ["PENDING_DEPOSIT", "PROCESSING", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT"];
    expect(settled.every(isTerminal)).toBe(true);
    expect(moving.some(isTerminal)).toBe(false);
  });
});

describe("waiting for a swap", () => {
  const nap = () => Promise.resolve();

  it("polls past the pending states and returns once it has settled", async () => {
    const states = ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"];
    let i = 0;
    const s = stub(() => ({ status: 200, body: statusBody(states[i++] ?? "SUCCESS", { amountOut: "1" }) }));
    const status = await new OneClick({ fetch: s.http }).waitForSwap({ depositAddress: DEPOSIT, pollMs: 1, sleep: nap });
    expect(status.state).toBe("SUCCESS");
    expect(s.count()).toBe(4);
  });

  it("stops at a short deposit rather than waiting for a state that never comes", async () => {
    const s = stub(() => ({ status: 200, body: statusBody("INCOMPLETE_DEPOSIT") }));
    const status = await new OneClick({ fetch: s.http }).waitForSwap({ depositAddress: DEPOSIT, pollMs: 1, sleep: nap });
    expect(status.state).toBe("INCOMPLETE_DEPOSIT");
    expect(s.count()).toBe(1);
  });

  it("gives up with the last state it saw, and says a retry is worthwhile", async () => {
    const s = stub(() => ({ status: 200, body: statusBody("PROCESSING") }));
    const wait = new OneClick({ fetch: s.http }).waitForSwap({
      depositAddress: DEPOSIT,
      pollMs: 1,
      timeoutMs: 5,
      sleep: nap,
    });
    await expect(wait).rejects.toMatchObject({ retryable: true });
    await expect(
      new OneClick({ fetch: s.http }).waitForSwap({ depositAddress: DEPOSIT, pollMs: 1, timeoutMs: 5, sleep: nap }),
    ).rejects.toThrow(/last seen: PROCESSING/);
  });

  it("backs off a rate limit instead of failing the wait", async () => {
    let n = 0;
    const s = stub(() => (++n < 3 ? { status: 429, body: { message: "slow down" } } : { status: 200, body: statusBody("SUCCESS") }));
    const status = await new OneClick({ fetch: s.http }).waitForSwap({ depositAddress: DEPOSIT, pollMs: 1, sleep: nap });
    expect(status.state).toBe("SUCCESS");
    expect(s.count()).toBe(3);
  });

  it("does not swallow an error it cannot retry", async () => {
    const s = stub(() => ({ status: 400, body: { message: "malformed address" } }));
    await expect(
      new OneClick({ fetch: s.http }).waitForSwap({ depositAddress: DEPOSIT, pollMs: 1, sleep: nap }),
    ).rejects.toThrow(/malformed address/);
    expect(s.count()).toBe(1);
  });
});

it("is an OneClickError that carries the status", async () => {
  const s = stub(() => ({ status: 503, body: { message: "upstream down" } }));
  const err = await new OneClick({ fetch: s.http }).quote(REQ).catch((e) => e);
  expect(err).toBeInstanceOf(OneClickError);
  expect(err).toMatchObject({ status: 503, retryable: true });
});
