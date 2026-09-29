import { describe, expect, it } from "vitest";
import { NEAR_ASSETS, NearIntentsError, quoteSwap, swapStatus, usdPerZec } from "./index.ts";

function fakeFetch(body: unknown, ok = true, calls: RequestInit[] = []) {
  return (async (_url: string, init?: RequestInit) => {
    if (init) calls.push(init);
    return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

describe("NEAR Intents 1Click client", () => {
  it("requests an exact-input USDC → ZEC quote delivered to a Zcash address", async () => {
    const calls: RequestInit[] = [];
    const q = await quoteSwap(
      { originAsset: NEAR_ASSETS.baseUSDC, destinationAsset: NEAR_ASSETS.ZEC, amount: 50_000_000n, recipient: "u1vault", refundTo: "0xrefund" },
      { fetchImpl: fakeFetch({ quote: { amountIn: "50000000", amountOut: "3480295", minAmountOut: "3445492", amountInUsd: "50.0", amountOutUsd: "49.44", timeEstimate: 150 } }, true, calls) },
    );
    const sent = JSON.parse(String(calls[0]!.body));
    expect(sent).toMatchObject({ dry: true, swapType: "EXACT_INPUT", originAsset: NEAR_ASSETS.baseUSDC, destinationAsset: "nep141:zec.omft.near", amount: "50000000", recipient: "u1vault", recipientType: "DESTINATION_CHAIN" });
    expect(q).toMatchObject({ amountOut: 3_480_295n, minAmountOut: 3_445_492n, timeEstimate: 150 });
    expect(Math.round(usdPerZec(q))).toBe(1437);
  });

  it("surfaces API errors and reads swap status", async () => {
    await expect(
      quoteSwap({ originAsset: "a", destinationAsset: "b", amount: 1n, recipient: "r", refundTo: "x" }, { fetchImpl: fakeFetch({ message: "amount is too low" }, false) }),
    ).rejects.toThrow(NearIntentsError);
    expect(await swapStatus("dep1", { fetchImpl: fakeFetch({ status: "SUCCESS" }) })).toBe("SUCCESS");
  });
});
