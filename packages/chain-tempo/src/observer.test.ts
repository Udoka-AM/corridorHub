import { describe, expect, it } from "vitest";
import { TempoObserver, blockTimes } from "./observer.ts";

const VAULT = "0xB4F90ffbF68a7C235D2Fee06adD744AAbE1C312f";

describe("Tempo observer timestamps", () => {
  it("fetches each block's timestamp once", async () => {
    const calls: bigint[] = [];
    const client = { getBlock: async ({ blockNumber }: { blockNumber: bigint }) => (calls.push(blockNumber), { timestamp: 1_790_000_000n + blockNumber }) };
    const cache = await blockTimes(client as never, [5n, 5n, 7n]);
    await blockTimes(client as never, [7n, 9n], cache);
    expect(calls.sort()).toEqual([5n, 7n, 9n]);
    expect(cache.get(5n)!.toISOString()).toBe(new Date((1_790_000_000 + 5) * 1000).toISOString());
  });

  it("stamps observations with the block's time, not the poll time", async () => {
    const log = { transactionHash: "0xaa", logIndex: 1, blockNumber: 120n, args: { from: "0x01", to: VAULT, amount: 5_000_000n, memo: `0x${"00".repeat(32)}` } };
    const client = {
      getBlockNumber: async () => 120n,
      getLogs: async (q: { args: { to?: unknown } }) => (q.args.to ? [log] : []),
      getBlock: async () => ({ timestamp: 1_790_000_000n }),
    };
    const store = new Map<string, bigint>();
    const [obs] = await new TempoObserver(client as never, {
      name: "t", asset: "pathUSD", addresses: [VAULT], startBlock: 100n,
      cursors: { get: async (n) => store.get(n), set: async (n, b) => void store.set(n, b) },
    }).poll();
    expect(obs!.observedAt.toISOString()).toBe(new Date(1_790_000_000 * 1000).toISOString());
    expect(obs!.amount).toBe(5_000_000n);
  });

  it("waits and retries the same window when the RPC rate-limits", async () => {
    let calls = 0;
    const client = {
      getBlockNumber: async () => 110n,
      getLogs: async () => {
        if (calls++ === 0) throw new Error("Request exceeds defined limit.");
        return [];
      },
      getBlock: async () => ({ timestamp: 0n }),
    };
    const store = new Map<string, bigint>();
    await new TempoObserver(client as never, {
      name: "t", asset: "pathUSD", addresses: [VAULT], startBlock: 100n,
      cursors: { get: async (n) => store.get(n), set: async (n, b) => void store.set(n, b) },
    }).poll();
    expect(store.get("t")).toBe(110n);
  });

  it("halves its block range when the RPC caps the range", async () => {
    const spans: bigint[] = [];
    const client = {
      getBlockNumber: async () => 20_000n,
      getLogs: async (q: { fromBlock: bigint; toBlock: bigint }) => {
        const span = q.toBlock - q.fromBlock + 1n;
        if (span > 2_500n) throw new Error("eth_getLogs is limited to a 2,500 block range");
        spans.push(span);
        return [];
      },
      getBlock: async () => ({ timestamp: 0n }),
    };
    const store = new Map<string, bigint>();
    await new TempoObserver(client as never, {
      name: "t", asset: "pathUSD", addresses: [VAULT], startBlock: 10_001n,
      cursors: { get: async (n) => store.get(n), set: async (n, b) => void store.set(n, b) },
    }).poll();
    expect(Math.max(...spans.map(Number))).toBeLessThanOrEqual(2_500);
    expect(store.get("t")).toBe(20_000n);
  });
});
